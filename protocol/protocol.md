# Local Notes Host Protocol v1

The editor talks to a host through one JSON envelope. The editor does not
know whether the host is Avalonia, a browser fixture, or a future cloud host.

## Request

```json
{
  "protocolVersion": 1,
  "requestId": "unique-id",
  "kind": "saveDocument",
  "sourceDocumentId": "document-id",
  "payload": {}
}
```

Responses keep the same `requestId` and `kind`:

```json
{
  "protocolVersion": 1,
  "requestId": "unique-id",
  "kind": "saveDocument",
  "ok": true,
  "payload": {}
}
```

Failures use `ok: false` and an `{ code, message }` error object. Host-pushed
events omit `requestId`, for example `documentLoaded` and `notification`.

`documentChanged` carries `{ documentId }` after a source document changes.
Hosts supporting external change notifications can emit it without navigating
the editor. The editor reloads affected reference projections through
`loadDocument`, preserving ordinary text edits and instance overrides.
Same-document references are also refreshed after the save queue receives ACK.
The browser mock emits this event for its external-source-edit test helper;
the legacy desktop host does not yet broadcast external change notifications.

## Stable capabilities

`loadDocument`, `reloadDocument`, `saveDocument`, `openDocument`,
`navigateBack`, `navigateForward`, `executeCommand`, and `showNotification`.
Reference mutations are carried by `executeCommand` with an operation such as
`create-reference`, `save-override`, or `set-reference-mode`.

`saveDocument` is a serialized transaction. Its payload includes the document
ID, mutation ID, client version, title, and block snapshot. The response always
returns the document ID, mutation ID, and persisted client version.

## Reference presentation and placement

`set-reference-mode` persists `inline` (expanded body), `collapsed` (folded
body with a disclosure arrow), `link` (title only), or `sidebar`. The disclosure
arrow sends the same acknowledged command as the mode menu; it is not temporary
DOM state. These values reuse `reference_instances.mode`, without a schema change.

Embedded references use an empty `<span data-reference-host-id="host-block-id">`
anchor in the containing block's HTML. The reference host block has that block
as its `parent_id`. Rendering mounts the reference at the exact anchor; saving
strips its projected contents from the containing block. Only stable IDs and
local overrides are stored, never the rendered source snapshot.

Title links preview after 400 ms of hover. Single click opens a non-navigating
side pane; double click navigates to the stable document/block ID. Plain-link
previews are read-only; reference instances edit via their existing override API.

## Compatibility

The legacy `type` messages remain supported by the existing Avalonia resource
until the editor bundle is fully migrated. New editor code only uses this
protocol and the `EditorHostApi` transport.
