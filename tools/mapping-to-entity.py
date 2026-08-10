"""Turn a hand-written plume mapping into an @entity class.

A mapping is a list of field(name, column, sqltype) calls and a repository({...})
call. That is exactly what @entity reads off a decorated class, so the transform
is mechanical: one @column per field, @id on the one matching idField, and the
mapping function left delegating to the entity so every caller keeps working.

    python3 tools/mapping-to-entity.py <source.ts> <mappingName> <out.entity.ts> <ClassName>

The V1 mappings are deliberately not converted: they are snapshots of an older
schema used by migrations, and a snapshot that follows the current class is not
a snapshot.
"""
import re
import sys

TYPES = {
    "text": "string",
    "int": "int",
    "bool": "bool",
    "float8": "number",
    "double": "number",
    "real": "number",
    "bigint": "int",
    "timestamptz": "string",
    "jsonb": "string",
}


def camel_to_class(name):
    return name[0].upper() + name[1:]


def read_mapping(source, mapping):
    text = open(source).read()
    m = re.search(
        r"export function %s\(([^)]*)\): DbRepository \{(.*?)\n\}\n" % re.escape(mapping),
        text,
        re.S,
    )
    if not m:
        raise SystemExit("no mapping named %s in %s" % (mapping, source))
    body = m.group(2)
    fields = re.findall(r'field\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)', body)
    table = re.search(r'table:\s*"([^"]+)"', body)
    id_field = re.search(r'idField:\s*"([^"]+)"', body)
    id_column = re.search(r'idColumn:\s*"([^"]+)"', body)
    if not (fields and table and id_field and id_column):
        raise SystemExit("%s is not a plain field() mapping" % mapping)
    return fields, table.group(1), id_field.group(1), id_column.group(1)


def entity_source(class_name, table, fields, id_field, depth):
    up = "../" * depth
    out = ['import { EntityDescription, entity } from "%splume/entity.ts";' % up,
           'import { DbRepository } from "%splume/plume.ts";' % up,
           "",
           '@entity("%s")' % table,
           "export class %s {" % class_name]
    for name, column, sqltype in fields:
        declared = TYPES.get(sqltype, "string")
        if name == id_field:
            out.append("  @id")
        out.append('  @column("%s", "%s")' % (column, sqltype))
        out.append("  %s: %s;" % (name, declared))
        out.append("")
    args = ", ".join("%s: %s" % (n, TYPES.get(t, "string")) for n, _, t in fields)
    out.append("  constructor(%s) {" % args)
    for name, _, _ in fields:
        out.append("    this.%s = %s;" % (name, name))
    out.append("  }")
    out.append("}")
    out.append("")
    out.append("export function %sRepository(): DbRepository {" % (class_name[0].lower() + class_name[1:]))
    out.append("  return entity%s;" % class_name)
    out.append("}")
    return "\n".join(out) + "\n"


def main():
    source, mapping, out_path, class_name = sys.argv[1:5]
    fields, table, id_field, _ = read_mapping(source, mapping)
    depth = out_path.count("/") - out_path.count("packages/") + 1
    open(out_path, "w").write(entity_source(class_name, table, fields, id_field, depth))
    print("%-26s -> %s  (%d columns, table %s)" % (mapping, out_path, len(fields), table))


if __name__ == "__main__":
    main()
