---
'@toklyn/store': minor
---

Add `@toklyn/store/mongodb`: `MongoSessionStore` and `MongoAccessTokenRevocationStore` for MongoDB 6.0+ with the official driver (or `mongoose.connection.db`), plus `migrate` for the indexes. Rotation is a compare-and-swap on one session document, so it is atomic without transactions or a replica set. Expired documents are removed by TTL indexes.
