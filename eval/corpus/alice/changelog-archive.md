# Catalogue Service: Changelog Archive

Older releases, newest first. The current release notes are in the setup guide.

## v2.13.2

Fixes a crash in the weekly report when a supplier had no products. Adds a retry for failed email delivery. The minimum supported Node.js version is now 20.

## v2.13.0

Introduces the supplier filter in the products endpoint and the `has_more` field in all list responses. The default page size changes from 50 to 100 items. Clients that relied on the old page size must pass the `limit` parameter explicitly.

## v2.12.4

Security update of the HTTP library. Fixes a memory leak in the nightly import that appeared after about two weeks of uptime. Reduces the start-up time by loading the supplier list lazily.

## v2.12.0

First version with the admin interface written in React. Removes the old server-rendered pages. The import now runs in batches, which lowered the peak memory by about a third.

## v2.11.x

Maintenance releases that only updated dependencies and fixed documentation. No functional changes.
