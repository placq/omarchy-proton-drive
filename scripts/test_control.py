import importlib.machinery
import importlib.util
import io
import subprocess
import unittest
from pathlib import Path


def load_control():
    path = Path(__file__).with_name("omarchy-drive-control")
    loader = importlib.machinery.SourceFileLoader("omarchy_drive_control", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class ChunkSocket:
    def __init__(self, chunks):
        self.chunks = iter(chunks)

    def recv(self, _size):
        return next(self.chunks, b"")


class AuthenticationTests(unittest.TestCase):
    def test_auth_runs_only_while_every_service_is_stopped(self):
        control = load_control()
        calls = []

        def runner(command, check):
            calls.append((command, check))

        control.authenticate("login", "/cli", runner)
        self.assertEqual(calls[0][0][:4], ["systemctl", "--user", "stop", "omarchy-drive-mount.service"])
        self.assertEqual(calls[1], (["/cli", "auth", "login"], True))
        self.assertEqual(calls[2][0][:4], ["systemctl", "--user", "start", "omarchy-drive.service"])

    def test_services_restart_when_authentication_fails(self):
        control = load_control()
        calls = []

        def runner(command, check):
            calls.append(command)
            if command[:2] == ["/cli", "auth"]:
                raise subprocess.CalledProcessError(1, command)

        with self.assertRaises(subprocess.CalledProcessError):
            control.authenticate("logout", "/cli", runner)
        self.assertEqual(calls[-1][:4], ["systemctl", "--user", "start", "omarchy-drive.service"])


class BoundedWatchTests(unittest.TestCase):
    def test_fragmented_messages_are_relayed_with_framing_preserved(self):
        control = load_control()
        output = io.BytesIO()

        control.relay_bounded_watch(
            ChunkSocket([b'{"event":"Sta', b'tus"}\n{"event":"Conflict"}\n']),
            output,
            max_message_bytes=64,
            max_accumulated_bytes=128,
        )

        self.assertEqual(output.getvalue(), b'{"event":"Status"}\n{"event":"Conflict"}\n')

    def test_message_without_newline_cannot_grow_past_limit(self):
        control = load_control()

        with self.assertRaisesRegex(RuntimeError, "message exceeds"):
            control.relay_bounded_watch(
                ChunkSocket([b"12345", b"67890"]),
                io.BytesIO(),
                max_message_bytes=8,
                max_accumulated_bytes=64,
            )

    def test_single_delimited_message_cannot_exceed_limit(self):
        control = load_control()

        with self.assertRaisesRegex(RuntimeError, "message exceeds"):
            control.relay_bounded_watch(
                ChunkSocket([b"123456789\n"]),
                io.BytesIO(),
                max_message_bytes=8,
                max_accumulated_bytes=64,
            )

    def test_accumulated_stream_limit_restarts_long_lived_watch(self):
        control = load_control()
        output = io.BytesIO()

        with self.assertRaisesRegex(RuntimeError, "accumulated byte limit"):
            control.relay_bounded_watch(
                ChunkSocket([b"one\n", b"two\n", b"three\n"]),
                output,
                max_message_bytes=8,
                max_accumulated_bytes=10,
            )

        self.assertEqual(output.getvalue(), b"one\ntwo\n")

    def test_unterminated_final_message_is_rejected(self):
        control = load_control()

        with self.assertRaisesRegex(RuntimeError, "unterminated"):
            control.relay_bounded_watch(
                ChunkSocket([b"partial"]),
                io.BytesIO(),
                max_message_bytes=16,
                max_accumulated_bytes=32,
            )


if __name__ == "__main__":
    unittest.main()
