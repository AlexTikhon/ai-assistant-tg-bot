# Catalogue Service: Project Setup

This document describes how to set up the catalogue service for local development and what the main configuration files contain.

## Requirements

Install Node.js 20 or newer and PostgreSQL 15. Clone the repository, run `npm install` and then `npm run build`. The development server starts with `npm run dev` and listens on port 3000.

## Configuration

Settings are read from config/settings.yaml and from environment variables, and variables win. The file config/settings.yaml contains the default page size, the cache lifetime and the list of enabled suppliers. Secrets never belong into this file.

The important environment variables are:

- DATABASE_URL is the connection string of the PostgreSQL database.
- SMTP_PASSWORD is the password of the mailbox that sends the weekly product report.
- SUPPLIER_API_KEY authenticates the service at the supplier broker.

## API client and rate limits

The supplier API client limits itself to the number of requests set under `rate_limit.requests_per_minute` in config/settings.yaml. The default is 20 requests per minute. When the supplier answers with HTTP_429, the client waits for the time given in the Retry-After header and retries up to five times before it gives up and logs a warning.

## Database schema

The accounts table holds one row per customer. Every row in the orders table has a user_id column that references accounts.id with a foreign key, and deleting an account removes its orders. The products table is filled by the nightly import and must never be edited by hand.

## Frontend notes

The admin interface is written with React. Fetch data inside useEffect and always return a cleanup function that cancels the request, otherwise a component that unmounts while a request is running will try to update state that no longer exists. Prefer a data fetching library for anything that needs caching.

## Release notes

Version v2.14.1 fixes the duplicate products that appeared when two imports overlapped, and raises the default cache lifetime from 5 to 10 minutes. Version v2.14.0 introduced the weekly product report. Upgrade by running `npm run build` again and applying the pending database migrations.
