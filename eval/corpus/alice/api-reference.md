# Catalogue API Reference

The catalogue API gives read access to products and orders. All endpoints are served over HTTPS and return JSON.

## Authentication

Send the API key in the Authorization header as a bearer token. Keys are created in the admin interface and can be revoked at any time. A request without a valid key receives HTTP_401, and a key without the needed permission receives HTTP_403.

## Pagination

List endpoints return at most 100 items per page. Use the `cursor` value from the previous response to fetch the next page; the cursor is opaque and must not be modified. The response field `has_more` tells whether another page exists.

## Endpoints

GET /products returns the products, optionally filtered by `category` or `supplier`. GET /products/{id} returns one product with its price history. GET /orders returns the orders of the authenticated customer, newest first. Orders cannot be changed through the API once they have been shipped.

## Errors

Every error response has the fields `code`, `message` and `request_id`. HTTP_404 is returned for unknown ids, HTTP_422 for invalid filter values and HTTP_500 for unexpected failures on our side. Include the `request_id` when you contact support so that the logs can be found quickly.

## Versioning

The version is part of the path, for example /v2/products. A new major version is announced three months before the old one is switched off. Additive changes, such as new fields in a response, are made without a new version, so clients must ignore fields they do not know.
