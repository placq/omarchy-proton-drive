import socket
import tempfile
import threading
import unittest
from pathlib import Path

from rpc_client import RpcClient, RpcError, timeout_setting


class RpcClientTest(unittest.TestCase):
    def test_timeout_setting_is_positive_and_tunable(self):
        self.assertEqual(timeout_setting({}), 300.0)
        self.assertEqual(timeout_setting({"OMARCHY_DRIVE_RPC_TIMEOUT_SECONDS": "12.5"}), 12.5)
        for invalid in ("bad", "0", "-1", "nan", "inf"):
            self.assertEqual(timeout_setting({"OMARCHY_DRIVE_RPC_TIMEOUT_SECONDS": invalid}), 300.0)

    def test_closed_connection_fails_instead_of_spinning(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "rpc.sock")
            ready = threading.Event()

            def server():
                with socket.socket(socket.AF_UNIX) as listener:
                    listener.bind(path)
                    listener.listen(1)
                    ready.set()
                    connection, _ = listener.accept()
                    with connection:
                        connection.recv(65536)

            thread = threading.Thread(target=server)
            thread.start()
            self.assertTrue(ready.wait(1))
            with self.assertRaisesRegex(RpcError, "closed"):
                RpcClient(path, timeout=1).call("GetStatus")
            thread.join(1)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
