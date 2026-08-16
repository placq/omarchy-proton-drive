import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from drive_logic import ThumbnailWorkCache, drive_path, node_id, node_status, thumbnail_relevant


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

    def test_node_id_accepts_proton_uid_components(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file"
            path.touch()
            os.setxattr(path, "user.omarchy-drive.node-id", b"abc==~def_-")
            self.assertEqual(node_id(path), "abc==~def_-")

    def test_node_status_reads_valid_fuse_status_and_rejects_other_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file"
            path.touch()
            os.setxattr(path, "user.omarchy-drive.status", b"cloud-only")
            self.assertEqual(node_status(path), "cloud-only")
            os.setxattr(path, "user.omarchy-drive.status", b"unknown")
            with self.assertRaises(ValueError):
                node_status(path)

    def test_thumbnail_filter_skips_files_without_thumbnailers(self):
        self.assertTrue(thumbnail_relevant("image/png"))
        self.assertTrue(thumbnail_relevant("application/pdf"))
        self.assertFalse(thumbnail_relevant("application/octet-stream"))

    def test_thumbnail_work_is_repeated_only_after_metadata_changes(self):
        cache = ThumbnailWorkCache(max_entries=2)
        self.assertTrue(cache.claim("file:///a", ("cloud-only", 1)))
        self.assertFalse(cache.claim("file:///a", ("cloud-only", 1)))
        self.assertTrue(cache.claim("file:///a", ("cached", 1)))
        cache.discard("file:///a")
        self.assertTrue(cache.claim("file:///a", ("cached", 1)))

    def test_thumbnail_work_cache_is_bounded(self):
        cache = ThumbnailWorkCache(max_entries=2)
        cache.claim("file:///a", 1)
        cache.claim("file:///b", 1)
        cache.claim("file:///c", 1)
        self.assertTrue(cache.claim("file:///a", 1))


if __name__ == "__main__":
    unittest.main()
