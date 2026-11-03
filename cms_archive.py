"""Shared access to CMS's Provider Data Catalog hospital archive (used by build_core_tables.py and verify_against_cms.py).

CMS publishes a zip of every hospital dataset a few times a year. ARCHIVE_LIST returns them all as JSON (name, date, url);
HttpRangeFile lets zipfile read one CSV out of a snapshot without downloading the whole archive.
"""
import io
import urllib.request

ARCHIVE_PAGE = "https://data.cms.gov/provider-data/archived-data/hospitals"
ARCHIVE_LIST = "https://data.cms.gov/provider-data/api/1/archive/aggregate/theme/hospitals/relative"
BASE = "https://data.cms.gov/provider-data/sites/default/files/dataset-archives/theme/hospitals/"

# Report year -> snapshot date, per table. A report year is the year a measurement period ends. These are the snapshots
# the original build of this dashboard used; to add a newer year, pick the snapshot from ARCHIVE_LIST whose period ends in that year.
SNAPSHOTS = {
    "hai": {2019: "2021-04-28", 2020: "2021-10-27", 2021: "2022-10-06", 2022: "2023-11-06", 2023: "2024-10-30", 2024: "2025-11-26", 2025: "2026-02-25"},
    "hcahps": {2019: "2020-10-16", 2020: "2021-10-27", 2021: "2022-10-06", 2022: "2023-11-06", 2023: "2024-10-30", 2024: "2025-11-26", 2025: "2026-02-25"},
    # PSI-90 covers two years at a time and had no release ending in 2020
    "psi90": {2019: "2022-04-06", 2021: "2023-11-06", 2022: "2024-07-31", 2023: "2025-08-14", 2024: "2026-02-25"},
}


def snapshot_url(date):
    return f"{BASE}hospitals_{date}.zip"


class HttpRangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests, so zipfile can read one member without downloading the archive."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        head = urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=60)
        self.size = int(head.headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, buf):
        if self.pos >= self.size:
            return 0
        end = min(self.size, self.pos + len(buf)) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        data = urllib.request.urlopen(req, timeout=120).read()
        buf[: len(data)] = data
        self.pos += len(data)
        return len(data)
