#!/usr/bin/env python3
"""Session D-Bus bridge for the Proton Drive for Omarchy daemon's private RPC socket."""
from __future__ import annotations
import asyncio, json, os, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ipc.rpc_client import RpcClient, RpcError
from dbus_next.aio import MessageBus
from dbus_next.errors import DBusError
from dbus_next.service import ServiceInterface, method, signal

BUS_NAME = "io.github.placq.OmarchyProtonDrive1"
OBJECT_PATH = "/io/github/placq/OmarchyProtonDrive1"
SOCKET_PATH = os.environ.get("OMARCHY_DRIVE_SOCKET", f"{os.environ.get('XDG_RUNTIME_DIR', '/tmp')}/omarchy-drive.sock")
MOUNT_PATH = Path(os.environ.get("OMARCHY_DRIVE_MOUNT", str(Path.home() / ".local/share/omarchy-drive/mount"))).expanduser()
RPC_CLIENT = RpcClient(SOCKET_PATH)

def rpc(method_name: str, **params):
    try: return RPC_CLIENT.call(method_name, **params)
    except (OSError, RpcError) as error:
        message = str(error) if isinstance(error, RpcError) else "Proton Drive daemon is unavailable"
        raise DBusError(f"{BUS_NAME}.Error", message) from error

class OmarchyDriveInterface(ServiceInterface):
    def __init__(self): super().__init__(BUS_NAME)
    async def _json(self, name, **params): return json.dumps(await asyncio.to_thread(rpc, name, **params), ensure_ascii=False)

    @method()
    async def GetVersion(self) -> 's': return await self._json("GetVersion")
    @method()
    async def GetStatus(self) -> 's': return await self._json("GetStatus")
    @method()
    async def GetNodeStatus(self, node_id: 's') -> 's': return await self._json("GetNodeStatus", nodeId=node_id)
    @method()
    async def SetPinned(self, node_id: 's', pinned: 'b') -> 's': return await self._json("SetPinned", nodeId=node_id, pinned=pinned)
    @method()
    async def Evict(self, node_id: 's') -> 's': return await self._json("Evict", nodeId=node_id)
    @method()
    async def Retry(self, node_id: 's') -> 's': return await self._json("Retry", nodeId=node_id)
    @method()
    async def ResolveConflict(self, node_id: 's', resolution: 's', copy_name: 's') -> 's':
        params={"nodeId":node_id, "resolution":resolution}
        if copy_name: params["copyName"]=copy_name
        return json.dumps(await asyncio.to_thread(rpc, "ResolveConflict", **params), ensure_ascii=False)
    @method()
    async def GetTransfers(self) -> 's': return await self._json("GetTransfers")
    @method()
    async def CancelTransfer(self, transfer_id: 's') -> 's': return await self._json("CancelTransfer", transferId=transfer_id)
    @method()
    async def ClearCache(self) -> 's': return await self._json("ClearCache")
    @method()
    async def ClearPinnedCache(self) -> 's': return await self._json("ClearPinnedCache")
    @method()
    def OpenDrive(self) -> 'b':
        subprocess.Popen(["nautilus", str(MOUNT_PATH)], start_new_session=True); return True

    @signal()
    def ConnectionChanged(self, connected: 'b') -> 'b': return connected
    @signal()
    def NodeChanged(self, node_id: 's') -> 's': return node_id
    @signal()
    def TransferChanged(self, transfer_json: 's') -> 's': return transfer_json
    @signal()
    def ConflictDetected(self, node_id: 's') -> 's': return node_id
    @signal()
    def ConflictResolved(self, node_id: 's') -> 's': return node_id
    @signal()
    def AuthRequired(self) -> 's': return "auth-required"

async def forward_events(interface: OmarchyDriveInterface):
    connected_once = False
    startup_failures = 0
    while True:
        writer = None
        try:
            reader, writer = await asyncio.open_unix_connection(SOCKET_PATH)
            connected_once = True
            startup_failures = 0
            writer.write((json.dumps({"id":1,"method":"Watch","params":{}})+"\n").encode()); await writer.drain()
            while line := await reader.readline():
                message=json.loads(line)
                if not isinstance(message, dict): raise ValueError("invalid Watch message")
                event=message.get("event"); data=message.get("data") or {}
                if not isinstance(data, dict): raise ValueError("invalid Watch data")
                if event == "Status":
                    interface.ConnectionChanged(bool(data.get("connected")))
                    if not data.get("authenticated", False): interface.AuthRequired()
                elif event == "NodeChanged":
                    interface.NodeChanged(str(data.get("nodeId", "")))
                elif event == "TransferChanged":
                    interface.TransferChanged(json.dumps(data, ensure_ascii=False))
                elif event == "Conflict":
                    interface.ConflictDetected(str(data.get("nodeId", "")))
                elif event == "ConflictResolved":
                    interface.ConflictResolved(str(data.get("nodeId", "")))
        except (OSError, ValueError) as error:
            startup_failures += 1
            if connected_once or startup_failures % 15 == 0:
                print(json.dumps({"level":"warn", "event":"watch_reconnect", "error":str(error)}), flush=True)
            await asyncio.sleep(2)
        finally:
            if writer is not None:
                writer.close()
                try: await writer.wait_closed()
                except OSError: pass

async def main():
    bus=await MessageBus().connect(); interface=OmarchyDriveInterface(); bus.export(OBJECT_PATH, interface); await bus.request_name(BUS_NAME)
    await forward_events(interface)
if __name__ == "__main__": asyncio.run(main())
