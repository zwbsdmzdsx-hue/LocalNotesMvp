using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace LocalNotesMvp;

public sealed partial class NoteStore
{
    private sealed record QueryField(string Key, string Title, string Type, string? Formula, string? RelationDatabaseId, string? Rollup, string? RollupFieldKey);
    private sealed record QueryRecord(string Id, string? SourceDocumentId, string? SourceBlockId, Dictionary<string, object?> Values);
    private sealed record QueryDatabase(string Id, string NotebookId, string Title, List<QueryField> Fields, List<QueryRecord> Records);

    private QueryDatabase ReadQueryDatabase(SqliteConnection connection, string databaseId)
    {
        using var source = connection.CreateCommand();
        source.CommandText = "SELECT notebook_id,title FROM data_sources WHERE id=$id AND deleted_at IS NULL";
        source.Parameters.AddWithValue("$id", databaseId);
        using var sourceRow = source.ExecuteReader();
        if (!sourceRow.Read()) throw new InvalidOperationException("数据库不存在。");
        var notebookId = sourceRow.IsDBNull(0) ? "" : sourceRow.GetString(0);
        var title = sourceRow.GetString(1);
        sourceRow.Close();
        var fields = new List<QueryField>();
        using (var field = connection.CreateCommand())
        {
            field.CommandText = "SELECT field_key,title,type,formula,relation_database_id,rollup,rollup_field_key FROM data_fields WHERE database_id=$id AND deleted_at IS NULL ORDER BY position";
            field.Parameters.AddWithValue("$id", databaseId);
            using var rows = field.ExecuteReader();
            while (rows.Read()) fields.Add(new(rows.GetString(0), rows.GetString(1), rows.GetString(2), rows.IsDBNull(3) ? null : rows.GetString(3), rows.IsDBNull(4) ? null : rows.GetString(4), rows.IsDBNull(5) ? null : rows.GetString(5), rows.IsDBNull(6) ? null : rows.GetString(6)));
        }
        var records = new List<QueryRecord>();
        using (var record = connection.CreateCommand())
        {
            record.CommandText = "SELECT id,source_document_id,source_block_id FROM data_records WHERE database_id=$id AND deleted_at IS NULL ORDER BY position";
            record.Parameters.AddWithValue("$id", databaseId);
            var recordRows = new List<(string Id, string? DocumentId, string? BlockId)>();
            using (var rows = record.ExecuteReader()) while (rows.Read()) recordRows.Add((rows.GetString(0), rows.IsDBNull(1) ? null : rows.GetString(1), rows.IsDBNull(2) ? null : rows.GetString(2)));
            foreach (var row in recordRows)
            {
                var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                using var value = connection.CreateCommand();
                value.CommandText = "SELECT f.field_key,v.value_json FROM data_values v JOIN data_fields f ON f.id=v.field_id WHERE v.record_id=$id AND f.deleted_at IS NULL";
                value.Parameters.AddWithValue("$id", row.Id);
                using var valueRows = value.ExecuteReader();
                while (valueRows.Read()) values[valueRows.GetString(0)] = JsonValue(valueRows.GetString(1));
                records.Add(new(row.Id, row.DocumentId, row.BlockId, values));
            }
        }
        return new(databaseId, notebookId, title, fields, records);
    }

    private static object? JsonValue(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var value = doc.RootElement;
        return value.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.TryGetInt64(out var integer) ? integer : value.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Array => value.EnumerateArray().Select(item => item.ToString()).ToArray(),
            _ => value.ToString()
        };
    }

    private EditorCommandResult ExecuteDqlCommand(string documentId, JsonElement message)
    {
        var databaseId = message.GetProperty("databaseId").GetString() ?? throw new InvalidOperationException("缺少数据库 ID。");
        var query = message.TryGetProperty("query", out var queryValue) ? queryValue.GetString() ?? "FROM current" : "FROM current";
        using var connection = OpenConnection();
        var database = ReadQueryDatabase(connection, databaseId);
        var currentNotebook = DatabaseNotebookId(connection, documentId);
        var requestedNotebook = ParseDqlNotebook(query) ?? currentNotebook;
        if (!string.Equals(database.NotebookId, requestedNotebook, StringComparison.Ordinal))
            throw new InvalidOperationException("查询范围与数据库所属笔记本不一致；跨笔记本查询必须显式使用 notebook(\"id\")。");
        var catalog = new Dictionary<string, QueryDatabase> { [database.Id] = database };
        foreach (var targetId in database.Fields.Select(field => field.RelationDatabaseId).Where(id => !string.IsNullOrWhiteSpace(id)).Distinct()!)
            if (!catalog.ContainsKey(targetId!)) catalog[targetId!] = ReadQueryDatabase(connection, targetId!);
        var result = ExecuteDql(database, query, catalog);
        return new EditorCommandResult { State = GetEditorState(documentId), Result = result };
    }

    private static string? ParseDqlNotebook(string query)
    {
        foreach (var raw in query.Split('\n'))
        {
            var line = raw.Trim();
            if (!line.StartsWith("FROM ", StringComparison.OrdinalIgnoreCase)) continue;
            var source = line[5..].Trim();
            if (source.Equals("current", StringComparison.OrdinalIgnoreCase)) return null;
            var match = Regex.Match(source, "^notebook\\([\"']([^\"']+)[\"']\\)$", RegexOptions.IgnoreCase);
            if (!match.Success) throw new InvalidOperationException("FROM 只支持 current 或 notebook(\"id\")。");
            return match.Groups[1].Value;
        }
        return null;
    }

    private static Dictionary<string, object?> EnrichRecord(QueryDatabase database, QueryRecord record, IReadOnlyDictionary<string, QueryDatabase> catalog, bool includeRollups = true)
    {
        var values = new Dictionary<string, object?>(record.Values, StringComparer.OrdinalIgnoreCase);
        foreach (var field in database.Fields) if (values.TryGetValue(field.Key, out var value)) values[field.Title] = value;
        foreach (var field in database.Fields.Where(field => field.Type is "formula" or "rule"))
        {
            var value = SafeFormula.Evaluate(field.Formula ?? "", values); values[field.Key] = value; values[field.Title] = value;
        }
        foreach (var field in includeRollups ? database.Fields.Where(field => field.Type == "rollup") : [])
        {
            var relation = database.Fields.FirstOrDefault(candidate => candidate.Type == "record_relation" && (field.RelationDatabaseId is null || candidate.RelationDatabaseId == field.RelationDatabaseId));
            var ids = relation is null ? [] : values.GetValueOrDefault(relation.Key) switch { string[] list => list, string id when id.Length > 0 => [id], _ => [] };
            var targetId = field.RelationDatabaseId ?? relation?.RelationDatabaseId ?? database.Id;
            var target = catalog.GetValueOrDefault(targetId);
            var targets = target?.Records.Where(candidate => ids.Contains(candidate.Id)).ToList() ?? [];
            var aggregate = targets.Select(candidate => target is null ? null : EnrichRecord(target, candidate, new Dictionary<string, QueryDatabase> { [target.Id] = target }, false).GetValueOrDefault(field.RollupFieldKey ?? "")).Where(value => value is not null && value is not FormulaFailure).ToList();
            var numbers = aggregate.Select(value => double.TryParse(DisplayValue(value), NumberStyles.Any, CultureInfo.InvariantCulture, out var number) ? (double?)number : null).Where(value => value.HasValue).Select(value => value!.Value).ToList();
            values[field.Key] = field.Rollup switch { "count" => targets.Count, "sum" => numbers.Sum(), "avg" => numbers.Count > 0 ? numbers.Average() : null, "min" => numbers.Count > 0 ? numbers.Min() : null, "max" => numbers.Count > 0 ? numbers.Max() : null, "unique" => string.Join(", ", aggregate.Select(DisplayValue).Distinct()), _ => new FormulaFailure("runtime", "汇总字段缺少有效函数") };
        }
        return values;
    }

    private static object ExecuteDql(QueryDatabase database, string source, IReadOnlyDictionary<string, QueryDatabase> catalog)
    {
        string[]? table = null; string? where = null; string? sortKey = null; var sortDesc = false; string? groupBy = null; int? limit = null;
        foreach (var raw in source.Split('\n'))
        {
            var line = raw.Trim(); if (line.Length == 0) continue;
            if (line.StartsWith("TABLE ", StringComparison.OrdinalIgnoreCase)) table = line[6..].Split(',').Select(value => value.Trim()).Where(value => value.Length > 0).ToArray();
            else if (line.StartsWith("FROM ", StringComparison.OrdinalIgnoreCase)) ParseDqlNotebook(line);
            else if (line.StartsWith("WHERE ", StringComparison.OrdinalIgnoreCase)) where = line[6..].Trim();
            else if (line.StartsWith("SORT ", StringComparison.OrdinalIgnoreCase))
            {
                var match = Regex.Match(line, "^SORT\\s+([\\p{L}_][\\p{L}\\p{N}_-]*)(?:\\s+(ASC|DESC))?$", RegexOptions.IgnoreCase);
                if (!match.Success) throw new InvalidOperationException("SORT 语法无效。"); sortKey = match.Groups[1].Value; sortDesc = match.Groups[2].Value.Equals("DESC", StringComparison.OrdinalIgnoreCase);
            }
            else if (line.StartsWith("GROUP BY ", StringComparison.OrdinalIgnoreCase)) groupBy = line[9..].Trim();
            else if (line.StartsWith("LIMIT ", StringComparison.OrdinalIgnoreCase)) { if (!int.TryParse(line[6..].Trim(), out var value)) throw new InvalidOperationException("LIMIT 必须是数字。"); limit = Math.Clamp(value, 0, 1000); }
            else throw new InvalidOperationException("无法解析 DQL：" + line);
        }
        var selected = table is null ? database.Fields : database.Fields.Where(field => table.Contains(field.Key, StringComparer.OrdinalIgnoreCase) || table.Contains(field.Title, StringComparer.OrdinalIgnoreCase)).ToList();
        var rows = database.Records.Select(record =>
        {
            var values = EnrichRecord(database, record, catalog);
            return (Record: record, Values: values);
        }).ToList();
        if (where is not null) rows = rows.Where(row => MatchesWhere(row.Values, where)).ToList();
        if (sortKey is not null) rows = (sortDesc ? rows.OrderByDescending(row => SortValue(row.Values.GetValueOrDefault(sortKey))) : rows.OrderBy(row => SortValue(row.Values.GetValueOrDefault(sortKey)))).ToList();
        if (limit is not null) rows = rows.Take(limit.Value).ToList();
        var resultRows = new List<object>();
        string? lastGroup = null;
        foreach (var row in rows)
        {
            if (groupBy is not null)
            {
                var group = DisplayValue(row.Values.GetValueOrDefault(groupBy));
                if (group != lastGroup) { resultRows.Add(new { recordId = "group:" + group, values = new Dictionary<string, object?> { [groupBy] = group }, grouped = true, readonlyKeys = selected.Select(field => field.Key).ToArray() }); lastGroup = group; }
            }
            resultRows.Add(new { recordId = row.Record.Id, sourceDocumentId = row.Record.SourceDocumentId, sourceBlockId = row.Record.SourceBlockId, values = selected.ToDictionary(field => field.Key, field => row.Values.GetValueOrDefault(field.Key)), readonlyKeys = database.Fields.Where(field => field.Type is "formula" or "rule" or "rollup").Select(field => field.Key).ToArray() });
        }
        return new { columns = selected.Select(field => new { key = field.Key, title = field.Title, type = field.Type }), rows = resultRows, errors = Array.Empty<object>() };
    }

    private static bool MatchesWhere(Dictionary<string, object?> values, string clause)
    {
        var match = Regex.Match(clause, "^([\\p{L}_][\\p{L}\\p{N}_-]*)\\s*(=|!=|>=|<=|>|<|contains)\\s*(?:\"([^\"]*)\"|'([^']*)'|(-?\\d+(?:\\.\\d+)?))$", RegexOptions.IgnoreCase);
        if (!match.Success) throw new InvalidOperationException("WHERE 语法无效。");
        var actual = values.GetValueOrDefault(match.Groups[1].Value); object? expected = match.Groups[3].Success ? match.Groups[3].Value : match.Groups[4].Success ? match.Groups[4].Value : double.Parse(match.Groups[5].Value, CultureInfo.InvariantCulture);
        var op = match.Groups[2].Value.ToLowerInvariant();
        if (op == "contains") return DisplayValue(actual).Contains(DisplayValue(expected), StringComparison.OrdinalIgnoreCase);
        if (op is "=" or "!=") { var equal = DisplayValue(actual) == DisplayValue(expected); return op == "=" ? equal : !equal; }
        var a = Convert.ToDouble(actual ?? 0, CultureInfo.InvariantCulture); var b = Convert.ToDouble(expected, CultureInfo.InvariantCulture);
        return op switch { ">" => a > b, ">=" => a >= b, "<" => a < b, _ => a <= b };
    }

    private static string SortValue(object? value) => value is IFormattable formatted ? formatted.ToString(null, CultureInfo.InvariantCulture) ?? "" : DisplayValue(value);
    private static string DisplayValue(object? value) => value switch { null => "", string[] values => string.Join(", ", values), FormulaFailure error => "#ERROR " + error.Message, _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "" };

    private EditorCommandResult ExportDatabaseCommand(string documentId, JsonElement message, bool csv)
    {
        var databaseId = message.GetProperty("databaseId").GetString() ?? throw new InvalidOperationException("缺少数据库 ID。");
        using var connection = OpenConnection(); var database = ReadQueryDatabase(connection, databaseId);
        if (database.NotebookId != DatabaseNotebookId(connection, documentId)) throw new InvalidOperationException("数据库不属于当前笔记本。");
        var catalog = new Dictionary<string, QueryDatabase> { [database.Id] = database };
        foreach (var targetId in database.Fields.Select(field => field.RelationDatabaseId).Where(id => !string.IsNullOrWhiteSpace(id)).Distinct()!)
            if (!catalog.ContainsKey(targetId!)) catalog[targetId!] = ReadQueryDatabase(connection, targetId!);
        var rows = database.Records.Select(record =>
        {
            return EnrichRecord(database, record, catalog);
        }).ToList();
        string Escape(string value) => csv ? "\"" + value.Replace("\"", "\"\"") + "\"" : value.Replace("|", "\\|").Replace("\r", " ").Replace("\n", " ");
        var builder = new StringBuilder();
        if (csv)
        {
            builder.AppendLine(string.Join(',', database.Fields.Select(field => Escape(field.Title))));
            foreach (var row in rows) builder.AppendLine(string.Join(',', database.Fields.Select(field => Escape(DisplayValue(row.GetValueOrDefault(field.Key))))));
        }
        else
        {
            builder.AppendLine("| " + string.Join(" | ", database.Fields.Select(field => Escape(field.Title))) + " |");
            builder.AppendLine("| " + string.Join(" | ", database.Fields.Select(_ => "---")) + " |");
            foreach (var row in rows) builder.AppendLine("| " + string.Join(" | ", database.Fields.Select(field => Escape(DisplayValue(row.GetValueOrDefault(field.Key))))) + " |");
        }
        return new EditorCommandResult { State = GetEditorState(documentId), Content = builder.ToString(), MimeType = csv ? "text/csv" : "text/markdown", FileName = database.Title + (csv ? ".csv" : ".md") };
    }

    private sealed record FormulaFailure(string Code, string Message);

    private static class SafeFormula
    {
        private sealed record Token(string Kind, string Value);
        private static readonly Regex TokenPattern = new("\\G\\s*(?:(?<number>\\d+(?:\\.\\d+)?)|(?<string>\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*')|(?<name>[A-Za-z_][A-Za-z0-9_]*)|(?<op>>=|<=|!=|==|[-+*/><=(),]))", RegexOptions.Compiled);
        public static object? Evaluate(string source, Dictionary<string, object?> values)
        {
            try { var parser = new FormulaParser(Tokenize(source), values); var value = parser.Parse(); parser.Complete(); return value; }
            catch (FormulaException error) { return new FormulaFailure(error.Code, error.Message); }
            catch (Exception error) { return new FormulaFailure("runtime", error.Message); }
        }
        private static List<Token> Tokenize(string source)
        {
            var result = new List<Token>(); var index = 0;
            while (index < source.Length)
            {
                var match = TokenPattern.Match(source, index); if (!match.Success) throw new FormulaException("syntax", "不支持的公式内容。");
                index = match.Index + match.Length;
                var group = match.Groups.Cast<Group>().First(item => item.Success && (item.Name is "number" or "string" or "name" or "op"));
                result.Add(new(group.Name, group.Value));
            }
            return result;
        }
        private sealed class FormulaException(string code, string message) : Exception(message) { public string Code { get; } = code; }
        private sealed class FormulaParser(List<Token> tokens, Dictionary<string, object?> values)
        {
            private int _index; private Token? Peek => _index < tokens.Count ? tokens[_index] : null;
            private bool Accept(string value) { if (Peek?.Value != value) return false; _index++; return true; }
            private Token Take() => _index < tokens.Count ? tokens[_index++] : throw new FormulaException("syntax", "公式缺少值。");
            public object? Parse() => Compare();
            public void Complete() { if (Peek is not null) throw new FormulaException("syntax", "公式中存在多余内容。"); }
            private object? Compare() { var left = Add(); while (Peek is { Value: "=" or "==" or "!=" or ">" or ">=" or "<" or "<=" }) { var op = Take().Value; var right = Add(); left = CompareValues(left, right, op); } return left; }
            private object? Add() { var left = Multiply(); while (Peek is { Value: "+" or "-" }) { var op = Take().Value; var right = Multiply(); left = op == "+" ? Number(left) + Number(right) : Number(left) - Number(right); } return left; }
            private object? Multiply() { var left = Unary(); while (Peek is { Value: "*" or "/" }) { var op = Take().Value; var right = Unary(); var divisor = Number(right); if (op == "/" && divisor == 0) throw new FormulaException("runtime", "不能除以零。"); left = op == "*" ? Number(left) * divisor : Number(left) / divisor; } return left; }
            private object? Unary() => Accept("-") ? -Number(Unary()) : Primary();
            private object? Primary()
            {
                var token = Take();
                if (token.Kind == "number") return double.Parse(token.Value, CultureInfo.InvariantCulture);
                if (token.Kind == "string") return Regex.Unescape(token.Value[1..^1]);
                if (token.Kind == "name")
                {
                    if (token.Value is "true" or "false") return token.Value == "true"; if (token.Value == "null") return null;
                    if (!Accept("(")) return values.TryGetValue(token.Value, out var property) ? property : throw new FormulaException("unknown_property", "未知属性：" + token.Value);
                    var args = new List<object?>(); if (!Accept(")")) { do { args.Add(Compare()); } while (Accept(",")); if (!Accept(")")) throw new FormulaException("syntax", "括号不匹配。"); }
                    return Call(token.Value, args);
                }
                if (token.Value == "(") { var value = Compare(); if (!Accept(")")) throw new FormulaException("syntax", "括号不匹配。"); return value; }
                throw new FormulaException("syntax", "无法解析公式。");
            }
            private object? Call(string name, List<object?> args) => name switch
            {
                "prop" when args.Count == 1 => values.TryGetValue(Text(args[0]), out var value) ? value : throw new FormulaException("unknown_property", "未知属性：" + Text(args[0])),
                "if" when args.Count == 3 => Truth(args[0]) ? args[1] : args[2],
                "concat" => string.Concat(args.Select(Text)),
                "coalesce" => args.FirstOrDefault(value => value is not null && Text(value).Length > 0),
                "round" when args.Count is 1 or 2 => Math.Round(Number(args[0]), args.Count == 2 ? Convert.ToInt32(Number(args[1])) : 0),
                "today" when args.Count == 0 => DateTime.UtcNow.ToString("yyyy-MM-dd"),
                "dateDiff" when args.Count == 3 => (DateTime.Parse(Text(args[0]), CultureInfo.InvariantCulture) - DateTime.Parse(Text(args[1]), CultureInfo.InvariantCulture)).Days,
                _ => throw new FormulaException("syntax", "不支持的函数：" + name)
            };
            private static double Number(object? value) => double.TryParse(Text(value), NumberStyles.Any, CultureInfo.InvariantCulture, out var number) ? number : throw new FormulaException("type", "需要数字值。");
            private static string Text(object? value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            private static bool Truth(object? value) => value switch { bool flag => flag, null => false, double number => number != 0, _ => Text(value).Length > 0 };
            private static bool CompareValues(object? left, object? right, string op)
            {
                if (op is "=" or "==" or "!=") { var equal = Text(left) == Text(right); return op == "!=" ? !equal : equal; }
                var a = Number(left); var b = Number(right); return op switch { ">" => a > b, ">=" => a >= b, "<" => a < b, _ => a <= b };
            }
        }
    }
}
