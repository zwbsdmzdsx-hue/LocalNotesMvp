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

## Compatibility

The legacy `type` messages remain supported by the existing Avalonia resource
until the editor bundle is fully migrated. New editor code only uses this
protocol and the `EditorHostApi` transport.
