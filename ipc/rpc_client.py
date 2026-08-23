"""Shared bounded client for the daemon's private newline-delimited RPC socket."""
from __future__ import annotations

import json
import math
import os
import socket


DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class RpcError(RuntimeError):
    """A transport, protocol, or daemon RPC failure."""


def timeout_setting(environment=os.environ) -> float:
    raw = environment.get("OMARCHY_DRIVE_RPC_TIMEOUT_SECONDS", "300")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 300.0
    return value if math.isfinite(value) and value > 0 else 300.0


class RpcClient:
    def __init__(
        self,
        path: str,
        timeout: float | None = None,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    ):
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        self.path = path
        self.timeout = timeout_setting() if timeout is None else timeout
        self.max_response_bytes = max_response_bytes
        self.sequence = 0

    def call(self, method: str, **params):
        self.sequence += 1
        request = (json.dumps({"id": self.sequence, "method": method, "params": params}) + "\n").encode()
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(self.timeout)
            connection.connect(self.path)
            connection.sendall(request)
            data = bytearray()
            while True:
                # Read at most one byte beyond the ceiling so an unterminated or
                # oversized daemon response is rejected without an unbounded
                # client-side allocation.
                remaining = self.max_response_bytes + 1 - len(data)
                part = connection.recv(min(65536, remaining))
                if not part:
                    raise RpcError("Proton Drive daemon closed the RPC connection without a response")
                data.extend(part)
                newline = data.find(b"\n")
                if newline >= 0:
                    if newline > self.max_response_bytes:
                        raise RpcError("Proton Drive daemon RPC response exceeds the byte limit")
                    response_data = bytes(data[:newline])
                    break
                if len(data) > self.max_response_bytes:
                    raise RpcError("Proton Drive daemon RPC response exceeds the byte limit")
        try:
            response = json.loads(response_data)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RpcError("Proton Drive daemon returned an invalid RPC response") from error
        if not isinstance(response, dict):
            raise RpcError("Proton Drive daemon returned an invalid RPC response")
        if "error" in response:
            detail = response["error"]
            message = detail.get("message", "RPC request failed") if isinstance(detail, dict) else "RPC request failed"
            raise RpcError(str(message))
        if "result" not in response:
            raise RpcError("Proton Drive daemon returned an RPC response without a result")
        return response["result"]
