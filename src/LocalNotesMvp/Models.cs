using System.Text.Json;

namespace LocalNotesMvp;

public sealed class Note
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "未命名笔记";
    public string ContentJson { get; set; } = "[]";
    public bool IsSticky { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public override string ToString() => Title;
}

public sealed class NoteStore
{
    private readonly string _path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalNotesMvp", "notes.json");
    private readonly JsonSerializerOptions _options = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private List<Note> _notes = [];

    public IReadOnlyList<Note> Notes => _notes;

    public void Load()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        if (File.Exists(_path))
            _notes = JsonSerializer.Deserialize<List<Note>>(File.ReadAllText(_path), _options) ?? [];
        if (_notes.Count == 0)
        {
            _notes.Add(new Note { Title = "欢迎使用本地笔记", ContentJson = "[{\"type\":\"paragraph\",\"text\":\"这是一个本地优先的块编辑器。点击这里开始记录。\"}]" });
            Save();
        }
    }

    public Note Create(bool sticky = false)
    {
        var note = new Note { Title = sticky ? "新便签" : "新笔记", IsSticky = sticky };
        _notes.Insert(0, note);
        Save();
        return note;
    }

    public void Save() => File.WriteAllText(_path, JsonSerializer.Serialize(_notes, _options));
    public Note? Find(string id) => _notes.FirstOrDefault(x => x.Id == id);
}
