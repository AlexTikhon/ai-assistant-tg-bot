# Meeting Notes, March 2026

## Platform sync, 4 March

Attendees: platform team and two people from the product side.

Topics: The Mercury migration moves the order service from the old data centre to the new cluster. The first phase starts on 18 March and covers the read-only endpoints. Mercury will run next to the old service for two weeks before traffic is switched over. Owner of the migration is the platform lead. Risk: the old service uses a custom authentication header that Mercury does not support yet, so a compatibility layer is needed.

Decisions: The migration plan is approved. Rollback has to be possible within ten minutes during the whole parallel phase.

## Product review, 11 March

Topics: The weekly report will get a new section with the most viewed products. The team agreed to postpone the redesign of the search page to the next quarter. Customer support asked for an export of orders as a spreadsheet.

Decisions: Export is added to the backlog with medium priority. The search page redesign is postponed.

## Retrospective, 25 March

What went well: fewer incidents than in February and faster reviews. What did not go well: planning meetings often ran over time. Action: planning stays at 45 minutes, and unfinished topics move to the next meeting.
