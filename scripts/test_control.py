import importlib.machinery
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
