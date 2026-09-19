using System.Text.Json;

namespace LocalNotesMvp;

public interface INoteRepository
{
    IReadOnlyList<Workspace> GetWorkspaces();
    IReadOnlyList<Bookmark> GetBookmarks(string workspaceId);
    IReadOnlyList<Note> GetDocuments(string workspaceId, string bookmarkId);
    object GetEditorState(string documentId);
    object GetDocumentHistory(string documentId);
    long SaveTransaction(SaveTransactionRequest request);
    MediaAssetRecord StoreMedia(StoreMediaRequest request);
    object ExecuteEditorCommand(string documentId, JsonElement message);
}
