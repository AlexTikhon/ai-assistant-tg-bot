# Feed Ingestion Operations Runbook

The cat feed importer (`feed-ingest.service`) pulls the hourly catalogue of cat food products from the supplier broker and writes it to the products database. This runbook explains how to keep it healthy and what to do when it is not.

## Service basics

The importer runs under systemd. Restart it with `systemctl restart feed-ingest.service` and check its state with `systemctl status feed-ingest.service`. It writes its logs to /var/log/feed/ingest.log and rotates them weekly. A healthy run finishes in under four minutes and ends with the line "ingest complete". If a run is still going after ten minutes, treat it as stuck and follow the error sections below.

## Common errors

### ECONNRESET

The error ECONNRESET means the supplier broker closed the connection while the importer was still reading the response. It is almost always caused by the broker's idle timeout of 30 seconds. Retry with `feed-ingest --retry 3`. If it keeps failing, lower BATCH_SIZE to 200 so every request finishes quickly, and report the incident to the platform team if it lasts longer than one hour.

### ETIMEDOUT

ETIMEDOUT appears when the broker does not answer within 20 seconds. This usually happens during the broker maintenance window on Sunday between 01:00 and 03:00 UTC. Wait for the window to end instead of restarting the service repeatedly, because every restart queues another full catalogue download.

### HTTP_429

HTTP_429 is the broker's rate limit response. The importer honours the Retry-After header and backs off exponentially, starting at 5 seconds and doubling up to 5 minutes. A burst of HTTP_429 responses is normal right after a restart. Never configure the importer to send more than 20 requests per minute, or the broker will block our address for a day.

### HTTP_503

HTTP_503 means the broker itself is overloaded. The importer treats it like a timeout and tries again after the next scheduled run. No manual action is needed unless the error persists for three consecutive runs.

## Database failover procedure

Follow these steps in order and do not skip any of them, even if the replica looks healthy.

Step 1: Freeze writes by putting the importer into maintenance mode with `feed-ingest --pause`. Wait until the dashboard shows zero active batches, which normally takes up to two minutes. Announce the freeze in the operations channel so nobody starts a manual import.

Step 2: Confirm that the replica lag is below one second on the monitoring dashboard. If the lag is higher, wait and check again; promoting a lagging replica loses the most recent product updates and cannot be undone without a restore.

Step 3: Promote the replica with `db-admin promote replica-b`. The command prints the new primary address when it succeeds. Copy this address, because the next step needs it, and keep the terminal open until the failover is finished.

Step 4: Update the stored database address in the secrets store so that it points to the new primary. Double check the host name and the port, since a typo here silently sends the importer to the old server.

Step 5: Restart feed-ingest.service so that it picks up the new address, and verify with the status command that it started without errors.

Step 6: Re-enable writes with `feed-ingest --resume` and watch the log for the next "ingest complete" line before closing the incident.

## Backups

Database backups run nightly at 02:00 UTC and are kept for 30 days. Restore tests are performed on the first Monday of every month by the platform team, and the result is posted in the operations channel.
