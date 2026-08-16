#!/usr/bin/env python3
"""FUSE3 adapter. Requires Arch packages python-pyfuse3 and python-trio."""
from __future__ import annotations
import argparse, errno, json, os, socket, stat, time
from pathlib import Path
import pyfuse3
import trio

def seconds_setting(name, default):
    try: return max(0.0, float(os.environ.get(name, default)))
    except ValueError: return default

ATTRIBUTE_TTL = seconds_setting("OMARCHY_DRIVE_FUSE_ATTRIBUTE_TTL", 5.0)
DIRECTORY_TTL = seconds_setting("OMARCHY_DRIVE_FUSE_DIRECTORY_TTL", 5.0)

class Rpc:
    def __init__(self, path: str): self.path, self.seq = path, 0
    def call(self, method: str, **params):
        self.seq += 1
        request = (json.dumps({"id": self.seq, "method": method, "params": params}) + "\n").encode()
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(5 * 60)
            conn.connect(self.path); conn.sendall(request); data = b""
            while b"\n" not in data: data += conn.recv(65536)
        response = json.loads(data.split(b"\n", 1)[0])
        if "error" in response: raise RuntimeError(response["error"]["message"])
        return response["result"]

class Operations(pyfuse3.Operations):
    enable_writeback_cache = False
    def __init__(self, rpc: Rpc):
        super().__init__(); self.rpc = rpc; self.next_inode = pyfuse3.ROOT_INODE + 1
        self.read_only = bool(self.rpc.call("GetVersion").get("readOnly", False))
        self.node_to_inode = {}; self.inode_to_node = {pyfuse3.ROOT_INODE: self.rpc.call("GetRoot")}
        self.handles = {}; self.writers = set(); self.next_handle = 1
        self.directory_handles = {}; self.next_directory_handle = 1
        self.directory_cache = {}
    async def call(self, method, **params):
        return await trio.to_thread.run_sync(lambda: self.rpc.call(method, **params))
    @staticmethod
    def is_local_trash(parent_inode, name):
        value=os.fsdecode(name)
        return parent_inode == pyfuse3.ROOT_INODE and (value == ".Trash" or (value.startswith(".Trash-") and value[7:].isdigit()))
    def inode(self, node):
        if node["id"] not in self.node_to_inode:
            self.node_to_inode[node["id"]] = self.next_inode; self.inode_to_node[self.next_inode] = node; self.next_inode += 1
        return self.node_to_inode[node["id"]]
    def visible_nodes(self, inode, nodes):
        if inode != pyfuse3.ROOT_INODE: return nodes
        return [node for node in nodes if not (node["name"] == ".Trash" or (node["name"].startswith(".Trash-") and node["name"][7:].isdigit()))]
    def update_directory_snapshots(self, parent_inode, removed_name=None, added_node=None):
        for directory in self.directory_handles.values():
            if directory["inode"] != parent_inode: continue
            if removed_name is not None: directory["nodes"] = [node for node in directory["nodes"] if node["name"] != removed_name]
            if added_node is not None: directory["nodes"].append(added_node)
        parent = self.inode_to_node.get(parent_inode)
        if parent: self.directory_cache.pop(parent["id"], None)
    def cached_directory(self, parent_id):
        cached = self.directory_cache.get(parent_id)
        if not cached: return None
        if cached["expires"] <= time.monotonic():
            self.directory_cache.pop(parent_id, None); return None
        return list(cached["nodes"])
    def remember_directory(self, parent_id, nodes):
        self.directory_cache[parent_id] = {"expires": time.monotonic() + DIRECTORY_TTL, "nodes": list(nodes)}
    def attrs(self, node, inode=None):
        a = pyfuse3.EntryAttributes(); a.st_ino = inode or self.inode(node); a.st_mode = (stat.S_IFDIR | 0o700) if node["kind"] == "folder" else (stat.S_IFREG | 0o600)
        a.st_nlink = 2 if node["kind"] == "folder" else 1; a.st_uid = os.getuid(); a.st_gid = os.getgid(); a.st_size = node.get("size", 0)
        ns = int(node.get("modifiedAt", time.time()*1000) * 1_000_000); a.st_atime_ns = a.st_mtime_ns = a.st_ctime_ns = ns
        a.entry_timeout = a.attr_timeout = ATTRIBUTE_TTL; a.st_blksize = 4096; a.st_blocks = (a.st_size + 511)//512; return a
    async def getattr(self, inode, ctx=None):
        node = self.inode_to_node.get(inode)
        if not node: raise pyfuse3.FUSEError(errno.ENOENT)
        return self.attrs(node, inode)
    async def lookup(self, parent_inode, name, ctx=None):
        parent = self.inode_to_node.get(parent_inode)
        if not parent: raise pyfuse3.FUSEError(errno.ENOENT)
        if self.is_local_trash(parent_inode, name): raise pyfuse3.FUSEError(errno.ENOENT)
        decoded_name = os.fsdecode(name)
        cached = self.cached_directory(parent["id"])
        if cached is not None:
            node = next((item for item in cached if item["name"] == decoded_name), None)
            if node is None: raise pyfuse3.FUSEError(errno.ENOENT)
            self.inode_to_node[self.inode(node)] = node; return self.attrs(node)
        try: node=await self.call("LookupChild", parentId=parent["id"], name=os.fsdecode(name))
        except RuntimeError as exc:
            if "not found" in str(exc).lower(): raise pyfuse3.FUSEError(errno.ENOENT) from exc
            raise pyfuse3.FUSEError(errno.EIO) from exc
        self.inode_to_node[self.inode(node)] = node; return self.attrs(node)
    async def opendir(self, inode, ctx):
        parent=self.inode_to_node.get(inode)
        if not parent: raise pyfuse3.FUSEError(errno.ENOENT)
        handle=self.next_directory_handle; self.next_directory_handle += 1
        nodes=self.cached_directory(parent["id"])
        if nodes is None:
            nodes=self.visible_nodes(inode, await self.call("ListChildren", nodeId=parent["id"]))
            self.remember_directory(parent["id"], nodes)
        self.directory_handles[handle]={"inode":inode,"nodes":nodes}; return handle
    async def readdir(self, fh, off, token):
        directory=self.directory_handles.get(fh)
        if not directory: raise pyfuse3.FUSEError(errno.EBADF)
        nodes=directory["nodes"]
        for index, node in enumerate(nodes, 1):
            if index <= off: continue
            self.inode_to_node[self.inode(node)] = node
            if not pyfuse3.readdir_reply(token, os.fsencode(node["name"]), self.attrs(node), index): break
    async def releasedir(self, fh):
        self.directory_handles.pop(fh, None)
    async def open(self, inode, flags, ctx):
        node = self.inode_to_node.get(inode)
        if not node: raise pyfuse3.FUSEError(errno.ENOENT)
        dirty = bool(flags & (os.O_WRONLY|os.O_RDWR|os.O_TRUNC|os.O_APPEND))
        if dirty and self.read_only: raise pyfuse3.FUSEError(errno.EROFS)
        if dirty and node["id"] in self.writers: raise pyfuse3.FUSEError(errno.EBUSY)
        if dirty: self.writers.add(node["id"])
        try: local = (await self.call("BeginWrite" if dirty else "Materialize", nodeId=node["id"]))["path"]
        except RuntimeError as exc:
            if dirty: self.writers.discard(node["id"])
            raise pyfuse3.FUSEError(errno.ENETDOWN if "offline" in str(exc).lower() else errno.EIO)
        except BaseException:
            if dirty: self.writers.discard(node["id"])
            raise
        node["localStatus"] = "dirty" if dirty else "cached"
        try: fd = os.open(local, flags & (os.O_RDONLY|os.O_WRONLY|os.O_RDWR|os.O_APPEND|os.O_TRUNC))
        except BaseException:
            if dirty: self.writers.discard(node["id"])
            raise
        fh = self.next_handle; self.next_handle += 1
        self.handles[fh] = (fd, node["id"], dirty); return pyfuse3.FileInfo(fh=fh)
    async def read(self, fh, off, size):
        if fh not in self.handles: raise pyfuse3.FUSEError(errno.EBADF)
        return os.pread(self.handles[fh][0], size, off)
    async def write(self, fh, off, buf):
        if fh not in self.handles: raise pyfuse3.FUSEError(errno.EBADF)
        return os.pwrite(self.handles[fh][0], buf, off)
    async def fsync(self, fh, datasync):
        if fh not in self.handles: raise pyfuse3.FUSEError(errno.EBADF)
        os.fsync(self.handles[fh][0])
    async def release(self, fh):
        handle = self.handles.pop(fh, None)
        if not handle: raise pyfuse3.FUSEError(errno.EBADF)
        fd, node_id, dirty = handle
        try:
            if dirty:
                os.fsync(fd)
                local_stat = os.fstat(fd)
                node = next((item for item in self.inode_to_node.values() if item["id"] == node_id), None)
                if node:
                    node["size"] = local_stat.st_size
                    node["modifiedAt"] = int(local_stat.st_mtime * 1000)
        finally:
            os.close(fd)
            if dirty: self.writers.discard(node_id)
        if dirty:
            node = next((item for item in self.inode_to_node.values() if item["id"] == node_id), None)
            if node: node["localStatus"] = "queued"
            inode = self.node_to_inode.get(node_id)
            if inode is not None:
                try: await trio.to_thread.run_sync(lambda: pyfuse3.invalidate_inode(inode, False))
                except OSError as exc:
                    if exc.errno != errno.ENOSYS: raise
            try: await self.call("CommitWrite", nodeId=node_id)
            except RuntimeError as exc: raise pyfuse3.FUSEError(errno.EIO) from exc
    async def mkdir(self, parent_inode, name, mode, ctx):
        if self.read_only: raise pyfuse3.FUSEError(errno.EROFS)
        if self.is_local_trash(parent_inode, name): raise pyfuse3.FUSEError(errno.EOPNOTSUPP)
        parent=self.inode_to_node.get(parent_inode)
        if not parent: raise pyfuse3.FUSEError(errno.ENOENT)
        node=await self.call("CreateFolder", parentId=parent["id"], name=os.fsdecode(name)); self.update_directory_snapshots(parent_inode, added_node=node); return self.attrs(node)
    async def create(self, parent_inode, name, mode, flags, ctx):
        if self.read_only: raise pyfuse3.FUSEError(errno.EROFS)
        parent=self.inode_to_node.get(parent_inode)
        if not parent: raise pyfuse3.FUSEError(errno.ENOENT)
        node=await self.call("CreateFile", parentId=parent["id"], name=os.fsdecode(name)); self.update_directory_snapshots(parent_inode, added_node=node); inode=self.inode(node)
        info=await self.open(inode, flags, ctx); entry=self.attrs(node, inode)
        entry.entry_timeout=entry.attr_timeout=0; return info, entry
    async def unlink(self, parent_inode, name, ctx):
        if self.read_only: raise pyfuse3.FUSEError(errno.EROFS)
        entry=await self.lookup(parent_inode, name, ctx); await self.call("Trash", nodeId=self.inode_to_node[entry.st_ino]["id"]); self.update_directory_snapshots(parent_inode, removed_name=os.fsdecode(name))
    async def rmdir(self, parent_inode, name, ctx):
        if self.read_only: raise pyfuse3.FUSEError(errno.EROFS)
        await self.unlink(parent_inode, name, ctx)
    async def rename(self, parent_inode_old, name_old, parent_inode_new, name_new, flags, ctx):
        if self.read_only: raise pyfuse3.FUSEError(errno.EROFS)
        if flags: raise pyfuse3.FUSEError(errno.EINVAL)
        entry=await self.lookup(parent_inode_old, name_old, ctx); node=self.inode_to_node[entry.st_ino]; new_parent=self.inode_to_node[parent_inode_new]
        old_name=node["name"]
        if node["parentId"] != new_parent["id"]: node=await self.call("Move", nodeId=node["id"], parentId=new_parent["id"])
        if node["name"] != os.fsdecode(name_new): node=await self.call("Rename", nodeId=node["id"], name=os.fsdecode(name_new))
        self.inode_to_node[entry.st_ino]=node
        self.update_directory_snapshots(parent_inode_old, removed_name=old_name)
        self.update_directory_snapshots(parent_inode_new, added_node=node)

    async def setattr(self, inode, attr, fields, fh, ctx):
        # Truncate locally; remote commit still occurs only after close.
        node = self.inode_to_node.get(inode)
        if not node: raise pyfuse3.FUSEError(errno.ENOENT)
        if getattr(fields, "update_size", False):
            if fh is None or fh not in self.handles: raise pyfuse3.FUSEError(errno.EBADF)
            os.ftruncate(self.handles[fh][0], attr.st_size)
        return self.attrs(node, inode)
    async def getxattr(self, inode, name, ctx):
        node = self.inode_to_node.get(inode)
        if not node: raise pyfuse3.FUSEError(errno.ENOENT)
        if os.fsdecode(name) == "user.omarchy-drive.node-id": return node["id"].encode()
        if os.fsdecode(name) == "user.omarchy-drive.status": return node.get("localStatus", "cloud-only").encode()
        raise pyfuse3.FUSEError(errno.ENODATA)
    async def listxattr(self, inode, ctx):
        if inode not in self.inode_to_node: raise pyfuse3.FUSEError(errno.ENOENT)
        # pyfuse3 expects a sequence of attribute names, not the packed
        # NUL-separated representation used by the low-level FUSE API.
        return [b"user.omarchy-drive.node-id", b"user.omarchy-drive.status"]

async def main():
    parser=argparse.ArgumentParser(); parser.add_argument("mountpoint"); parser.add_argument("--socket", required=True); args=parser.parse_args()
    Path(args.mountpoint).mkdir(parents=True, exist_ok=True); pyfuse3.init(Operations(Rpc(args.socket)), args.mountpoint, {"fsname=omarchy-drive", "subtype=omarchy-drive", "default_permissions", "x-gvfs-hide"})
    try: await pyfuse3.main()
    finally: pyfuse3.close(unmount=True)
if __name__ == "__main__": trio.run(main)
