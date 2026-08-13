#!/usr/bin/env python3
"""FUSE3 adapter. Requires Arch packages python-pyfuse3 and python-trio."""
from __future__ import annotations
import argparse, errno, json, os, socket, stat, time
from pathlib import Path
import pyfuse3
import trio

class Rpc:
    def __init__(self, path: str): self.path, self.seq = path, 0
    def call(self, method: str, **params):
        self.seq += 1
        request = (json.dumps({"id": self.seq, "method": method, "params": params}) + "\n").encode()
        with socket.socket(socket.AF_UNIX) as conn:
            conn.connect(self.path); conn.sendall(request); data = b""
            while b"\n" not in data: data += conn.recv(65536)
        response = json.loads(data.split(b"\n", 1)[0])
        if "error" in response: raise RuntimeError(response["error"]["message"])
        return response["result"]

class Operations(pyfuse3.Operations):
    enable_writeback_cache = True
    def __init__(self, rpc: Rpc):
        super().__init__(); self.rpc = rpc; self.next_inode = pyfuse3.ROOT_INODE + 1
        self.node_to_inode = {}; self.inode_to_node = {pyfuse3.ROOT_INODE: self.rpc.call("GetRoot")}
        self.handles = {}; self.writers = set(); self.next_handle = 1
    async def call(self, method, **params):
        return await trio.to_thread.run_sync(lambda: self.rpc.call(method, **params))
    def inode(self, node):
        if node["id"] not in self.node_to_inode:
            self.node_to_inode[node["id"]] = self.next_inode; self.inode_to_node[self.next_inode] = node; self.next_inode += 1
        return self.node_to_inode[node["id"]]
    def attrs(self, node, inode=None):
        a = pyfuse3.EntryAttributes(); a.st_ino = inode or self.inode(node); a.st_mode = (stat.S_IFDIR | 0o700) if node["kind"] == "folder" else (stat.S_IFREG | 0o600)
        a.st_nlink = 2 if node["kind"] == "folder" else 1; a.st_uid = os.getuid(); a.st_gid = os.getgid(); a.st_size = node.get("size", 0)
        ns = int(node.get("modifiedAt", time.time()*1000) * 1_000_000); a.st_atime_ns = a.st_mtime_ns = a.st_ctime_ns = ns
        a.entry_timeout = a.attr_timeout = 1.0; a.st_blksize = 4096; a.st_blocks = (a.st_size + 511)//512; return a
    async def getattr(self, inode, ctx=None):
        node = self.inode_to_node.get(inode)
        if not node: raise pyfuse3.FUSEError(errno.ENOENT)
        return self.attrs(node, inode)
    async def lookup(self, parent_inode, name, ctx=None):
        parent = self.inode_to_node.get(parent_inode)
        if not parent: raise pyfuse3.FUSEError(errno.ENOENT)
        wanted = os.fsdecode(name)
        for node in await self.call("ListChildren", nodeId=parent["id"]):
            if node["name"] == wanted: self.inode_to_node[self.inode(node)] = node; return self.attrs(node)
        raise pyfuse3.FUSEError(errno.ENOENT)
    async def opendir(self, inode, ctx):
        if inode not in self.inode_to_node: raise pyfuse3.FUSEError(errno.ENOENT)
        return inode
    async def readdir(self, inode, off, token):
        parent = self.inode_to_node.get(inode)
        if not parent: raise pyfuse3.FUSEError(errno.ENOENT)
        nodes = await self.call("ListChildren", nodeId=parent["id"])
        for index, node in enumerate(nodes, 1):
            if index <= off: continue
            self.inode_to_node[self.inode(node)] = node
            if not pyfuse3.readdir_reply(token, os.fsencode(node["name"]), self.attrs(node), index): break
    async def open(self, inode, flags, ctx):
        node = self.inode_to_node.get(inode)
        if not node: raise pyfuse3.FUSEError(errno.ENOENT)
        dirty = bool(flags & (os.O_WRONLY|os.O_RDWR|os.O_TRUNC|os.O_APPEND))
        if dirty and node["id"] in self.writers: raise pyfuse3.FUSEError(errno.EBUSY)
        if dirty: self.writers.add(node["id"])
        try: local = (await self.call("BeginWrite" if dirty else "Materialize", nodeId=node["id"]))["path"]
        except RuntimeError as exc:
            if dirty: self.writers.discard(node["id"])
            raise pyfuse3.FUSEError(errno.ENETDOWN if "offline" in str(exc).lower() else errno.EIO)
        except BaseException:
            if dirty: self.writers.discard(node["id"])
            raise
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
            if dirty: os.fsync(fd)
        finally:
            os.close(fd)
            if dirty: self.writers.discard(node_id)
        if dirty:
            try: await self.call("CommitWrite", nodeId=node_id)
            except RuntimeError as exc: raise pyfuse3.FUSEError(errno.EIO) from exc
    async def mkdir(self, parent_inode, name, mode, ctx):
        parent=self.inode_to_node.get(parent_inode)
        if not parent: raise pyfuse3.FUSEError(errno.ENOENT)
        node=await self.call("CreateFolder", parentId=parent["id"], name=os.fsdecode(name)); return self.attrs(node)
    async def create(self, parent_inode, name, mode, flags, ctx):
        parent=self.inode_to_node.get(parent_inode)
        if not parent: raise pyfuse3.FUSEError(errno.ENOENT)
        node=await self.call("CreateFile", parentId=parent["id"], name=os.fsdecode(name)); inode=self.inode(node)
        info=await self.open(inode, flags, ctx); return info, self.attrs(node, inode)
    async def unlink(self, parent_inode, name, ctx):
        entry=await self.lookup(parent_inode, name, ctx); await self.call("Trash", nodeId=self.inode_to_node[entry.st_ino]["id"])
    async def rmdir(self, parent_inode, name, ctx): await self.unlink(parent_inode, name, ctx)
    async def rename(self, parent_inode_old, name_old, parent_inode_new, name_new, flags, ctx):
        entry=await self.lookup(parent_inode_old, name_old, ctx); node=self.inode_to_node[entry.st_ino]; new_parent=self.inode_to_node[parent_inode_new]
        if node["parentId"] != new_parent["id"]: node=await self.call("Move", nodeId=node["id"], parentId=new_parent["id"])
        if node["name"] != os.fsdecode(name_new): await self.call("Rename", nodeId=node["id"], name=os.fsdecode(name_new))

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
        raise pyfuse3.FUSEError(errno.ENODATA)
    async def listxattr(self, inode, ctx):
        if inode not in self.inode_to_node: raise pyfuse3.FUSEError(errno.ENOENT)
        return b"user.omarchy-drive.node-id\x00"

async def main():
    parser=argparse.ArgumentParser(); parser.add_argument("mountpoint"); parser.add_argument("--socket", required=True); args=parser.parse_args()
    Path(args.mountpoint).mkdir(parents=True, exist_ok=True); pyfuse3.init(Operations(Rpc(args.socket)), args.mountpoint, {"fsname=omarchy-drive", "subtype=omarchy-drive", "default_permissions"})
    try: await pyfuse3.main()
    finally: pyfuse3.close(unmount=True)
if __name__ == "__main__": trio.run(main)
