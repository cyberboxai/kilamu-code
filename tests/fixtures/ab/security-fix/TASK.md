A security audit of this small service flagged two issues:

- `readUpload` in `src/files.js` can be made to read files outside the `uploads/` directory.
- `findUserByName` in `src/users.js` is vulnerable to SQL injection.

Fix both vulnerabilities without breaking legitimate use. Look for any other place in `src/` with the same weakness and fix it too. The tests in test/ define the expected behaviour.
