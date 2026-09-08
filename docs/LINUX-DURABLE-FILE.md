# Linux durable-file prerequisite

`lib/linux-durable-file.js` is an **unwired substrate**, not a journal, recovery
engine, writer lock, or filesystem sandbox. It does not change the current
Windows persistence helpers or production provider execution.

The integrating caller must qualify a Linux-native local filesystem, trusted
path ancestry and an already durable anchor. It must keep an exclusive
higher-level writer lock, validate journal schemas and expected revisions, and
reconcile uncertain effects before allowing replacement work. This module does
not claim protection from another process running as the same OS user.

```js
const { openLinuxDurableDirectory } = require('../lib/linux-durable-file');
const anchor = openLinuxDurableDirectory({ directory: '/qualified/private/anchor' });
const attempts = anchor.initializeChild('owner-attempts');
try {
  attempts.createExclusive('run-example.json', JSON.stringify(intent));
  // Under the caller's exclusive writer lock and expected-revision check:
  attempts.replaceAtomic('run-example.json', JSON.stringify(nextRevision));
} finally {
  attempts.close();
  anchor.close();
}
```

Root directory arguments must be normalized absolute paths without a trailing
slash; this avoids turning a leaf symlink into directory traversal before the
no-follow open. Trusted ancestry is still the caller's responsibility.

Handles keep a private, owner-matched `0700` directory descriptor and anchor
leaf operations through that descriptor. A later pathname replacement cannot
redirect the handle to a different directory. Directory initialization validates
and synchronizes the child, then synchronizes the parent entry. Initialize each
new ancestor this way from a known durable anchor; recursive `mkdir` alone does
not establish that guarantee. A confirmed new child is checked without following
a leaf symlink and set to exact `0700` before opening, including under restrictive
umask. This pathname permission step relies on the caller's trusted, exclusively
owned ancestry; it is not same-user adversary containment. Existing children are
never chmodded. A failed or ambiguous creation/permission operation leaves the
visible child for explicit recovery; retry does not repair invalid permissions.

Names are bounded single components, payloads are strings or Buffers capped at
256 KiB, and a write uses at most 1,024 progress-producing calls. These are bounds
on work/data, not promises about filesystem syscall wall time. A timeout cannot
prove a blocked filesystem operation did not publish.

Publication establishes and validates exact `0600` permissions on its own newly
created temporary descriptor, independent of inherited umask. It never repairs
existing files. It writes that same-directory temporary file completely, fsyncs
and closes it, then links it exclusively or renames it over an existing private
regular file. Only a successful containing-directory fsync confirms the barrier.
File fsync alone does not persist the directory entry. See the
[Linux fsync manual](https://man7.org/linux/man-pages/man2/fsync.2.html).

| Publication / durability | Meaning |
| --- | --- |
| `not_attempted` / `unconfirmed` | Failure occurred before canonical publication was attempted. |
| `conflict` / `unconfirmed` | Exclusive publication encountered an existing canonical name. |
| `unknown` / `unconfirmed` | Publication threw; callers must not infer that it had no effect. |
| `published` / `unconfirmed` | Publication returned, but directory durability was not confirmed. |
| `published` / `confirmed` | File and containing-directory barriers succeeded. |

For child initialization, `mkdir` itself is the canonical publication attempt.
Every non-`EEXIST` exception from that call is intentionally `unknown`, including
`EACCES` or `ENOSPC`: this API does not expose a proven-no-effect receipt or infer
one from errno. Injected filesystem wrappers can throw the same error before or
after an effect. A native call may in fact have done nothing; this conservative
classification still requires explicit reconciliation. `not_attempted` is not
a promise to classify every no-effect failure; it applies where this module has
not reached canonical publication, such as a temporary-file preparation failure.

`DurableFileError.details` reports the stage, bounded errno and these facts
without copying private error messages or payloads. Cleanup failure does not
hide a child's open/validation/sync stage (reported with a `child_` prefix) or
mask an earlier failure. Successful commitment with later temporary-link cleanup
failure returns confirmed durability plus `cleanupPending`/`cleanupError`; it is
not an indistinguishable failed write that may be blindly replayed.

The module never removes or restores the canonical file after publication.
Temporary files are not replay records and must never be promoted by timestamp,
filename or apparent completeness. Cleanup of the temporary link is best effort;
its disappearance is not itself a separately fsynced crash guarantee. A recovered
canonical file still needs schema/identity validation and an explicit durability
barrier before authorizing further effects. No generic replay reader or repair
operation is exposed here.

Atomic replacement is not compare-and-swap. This module supplies neither
cross-process generation fencing nor multi-file transactionality. Symlink/file
checks are defense in depth inside the caller's trusted ownership boundary.

Close errors are surfaced, but a descriptor is never retried after close: on
Linux the descriptor may already have been released and reused. See the
[Linux close manual](https://man7.org/linux/man-pages/man2/close.2.html).

Verification uses native temporary directories, injected faults and two benign
publisher subprocesses. Those tests establish syscall ordering and conservative
failure behavior, not an actual power-loss or storage-hardware qualification.
