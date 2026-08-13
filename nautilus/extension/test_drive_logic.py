import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from drive_logic import drive_path, node_id


class DriveLogicTest(unittest.TestCase):
    def test_drive_path_accepts_children_and_rejects_other_files(self):
        with tempfile.TemporaryDirectory() as directory:
            mount = Path(directory) / "Proton Drive"
            child = mount / "Documents" / "file.txt"
            child.parent.mkdir(parents=True)
            child.touch()
            self.assertEqual(drive_path(child.as_uri(), mount), child.resolve())
            outside = Path(directory) / "other.txt"
            outside.touch()
            self.assertIsNone(drive_path(outside.as_uri(), mount))

    def test_node_id_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file"
            path.touch()
            os.setxattr(path, "user.omarchy-drive.node-id", b"welcome")
            self.assertEqual(node_id(path), "welcome")
            os.setxattr(path, "user.omarchy-drive.node-id", b"../state")
            with self.assertRaises(ValueError):
                node_id(path)


if __name__ == "__main__":
    unittest.main()
