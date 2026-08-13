#!/usr/bin/env python3
"""Session D-Bus bridge for the Omarchy Drive daemon's private RPC socket."""
from __future__ import annotations
import asyncio, json, os, socket, subprocess
from pathlib import Path
from dbus_next.aio import MessageBus
from dbus_next.errors import DBusError
from dbus_next.service import ServiceInterface, method, signal

BUS_NAME = "io.github.omarchydrive.OmarchyDrive1"
OBJECT_PATH = "/io/github/omarchydrive/OmarchyDrive1"
SOCKET_PATH = os.environ.get("OMARCHY_DRIVE_SOCKET", f"{os.environ.get('XDG_RUNTIME_DIR', '/tmp')}/omarchy-drive.sock")

def rpc(method_name: str, **params):
    request=(json.dumps({"id":1,"method":method_name,"params":params})+"\n").encode()
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(30); connection.connect(SOCKET_PATH); connection.sendall(request); data=b""
        while b"\n" not in data:
            part=connection.recv(65536)
            if not part: break
            data += part
    response=json.loads(data.split(b"\n",1)[0])
    if "error" in response: raise DBusError(f"{BUS_NAME}.Error", response["error"]["message"])
    return response["result"]

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
    async def GetTransfers(self) -> 's': return await self._json("GetTransfers")
    @method()
    def OpenDrive(self) -> 'b':
        subprocess.Popen(["nautilus", str(Path.home()/"Proton Drive")], start_new_session=True); return True

    @signal()
    def ConnectionChanged(self, connected: 'b') -> 'b': return connected
    @signal()
    def NodeChanged(self, node_id: 's') -> 's': return node_id
    @signal()
    def TransferChanged(self, transfer_json: 's') -> 's': return transfer_json
    @signal()
    def ConflictDetected(self, node_id: 's') -> 's': return node_id
    @signal()
    def AuthRequired(self) -> 's': return "auth-required"

async def forward_events(interface: OmarchyDriveInterface):
    while True:
        try:
            reader, writer = await asyncio.open_unix_connection(SOCKET_PATH)
            writer.write((json.dumps({"id":1,"method":"Watch","params":{}})+"\n").encode()); await writer.drain()
            while line := await reader.readline():
                message=json.loads(line); event=message.get("event"); data=message.get("data") or {}
                if event == "Status": interface.ConnectionChanged(bool(data.get("connected")))
                elif event == "NodeChanged":
                    node_id=str(data.get("nodeId", "")); interface.NodeChanged(node_id)
                    try:
                        state=await asyncio.to_thread(rpc, "GetNodeStatus", nodeId=node_id)
                        if state and state.get("status") == "conflict": interface.ConflictDetected(node_id)
                    except Exception as error: print(json.dumps({"level":"warn", "event":"node_status_forward_failed", "error":str(error)}), flush=True)
                elif event == "TransferChanged": interface.TransferChanged(json.dumps(data, ensure_ascii=False))
            writer.close(); await writer.wait_closed()
        except (OSError, json.JSONDecodeError): await asyncio.sleep(2)

async def main():
    bus=await MessageBus().connect(); interface=OmarchyDriveInterface(); bus.export(OBJECT_PATH, interface); await bus.request_name(BUS_NAME)
    await forward_events(interface)
if __name__ == "__main__": asyncio.run(main())
