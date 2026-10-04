# Incident Review: Disk Full on the Primary Database, January 2026

## Summary

On a Tuesday night the primary database ran out of disk space because the write-ahead log was not being archived. Writes failed for 41 minutes. No data was lost. The importer queued its work and caught up after the recovery.

## Timeline

At 01:12 the first alert about low disk space fired but was acknowledged and snoozed. At 01:40 the disk was full and the application started to answer with errors. At 01:48 the on-call engineer decided to fail over to the replica. The failover followed the runbook and took 22 minutes in total, mostly because the replica had to be checked for lag first. At 02:21 writes were accepted again, and the old primary was cleaned up the next morning.

## Causes

The archive job had been failing silently for nine days after a certificate on the storage endpoint expired. Alerts for the job existed, but they went to a channel nobody watched. The disk alert threshold of 90 percent left too little time to react, because the log grows quickly during the nightly import.

## What went well

The failover worked as documented, and communication in the incident channel was clear. Customers were informed within fifteen minutes.

## Actions

Move the archive alerts to the on-call channel. Lower the disk alert threshold to 75 percent. Add a weekly check that the newest archived log is less than one hour old. Review the certificate expiry dates of all storage endpoints every quarter.
