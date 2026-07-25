import { checksum, versionValid, compareVersions, planOrder, planValid, Migration, migration, repeatable, quoted } from "./migrate.ts";
import { safeIdentifier, safeSqlType, pairsFromColumns, jsonMember, pickFields } from "./plume.ts";

console.log("crc32('')        = " + `${checksum("")}`);
console.log("crc32('a')       = " + `${checksum("a")}`);
console.log("crc32('123456789') = " + `${checksum("123456789")}`);
console.log("crc32('CREATE TABLE t (id text)') = " + `${checksum("CREATE TABLE t (id text)")}`);
console.log("crc32(utf8 'héllo') = " + `${checksum("héllo")}`);
console.log("crc32('The quick brown fox jumps over the lazy dog') = " + `${checksum("The quick brown fox jumps over the lazy dog")}`);

console.log("versionValid('1a') = " + `${versionValid("1a")}`);
console.log("versionValid('1b') = " + `${versionValid("1b")}`);
console.log("compareVersions('1','1.0') = " + `${compareVersions("1", "1.0")}`);
console.log("compareVersions('1.0','01.00') = " + `${compareVersions("1.0", "01.00")}`);

let empty: Migration[] = [];
console.log("planOrder(empty).length = " + `${planOrder(empty).length}`);
let allRep: Migration[] = [ repeatable("a", "SELECT 1"), repeatable("b", "SELECT 2") ];
console.log("planOrder(all repeatable) = " + planOrder(allRep).join(","));
let dup: Migration[] = [ migration("1", "x", "SELECT 1"), migration("1.0", "y", "SELECT 2") ];
console.log("planValid('1' and '1.0') = [" + planValid(dup) + "]  order=" + planOrder(dup).join(","));

// safeSqlType lets a comma, parens and spaces through. What else does that admit?
console.log("safeSqlType('int) , x int DEFAULT (1') = " + `${safeSqlType("int) , x int DEFAULT (1")}`);
console.log("safeSqlType('text CHECK (1=1)') = " + `${safeSqlType("text CHECK (1=1)")}`);
console.log("safeSqlType('generated always as identity') = " + `${safeSqlType("generated always as identity")}`);
console.log("safeIdentifier(unicode 'nomé') = " + `${safeIdentifier("nomé")}`);

// pairsFromColumns splits on commas.
console.log("pairs('a, b AS \"c\"')                = " + pairsFromColumns("a, b AS \"c\""));
console.log("pairs('coalesce(a, b) AS x')          = " + pairsFromColumns("coalesce(a, b) AS x"));
console.log("pairs(\"'has''quote' AS k\")           = " + pairsFromColumns("'x' AS k"));
console.log("pairs('a AS \"k'' OR 1=1--\"')         = " + pairsFromColumns("a AS \"k' OR 1=1--\""));

// jsonMember on nested things
console.log("jsonMember nested obj = " + jsonMember("{\"a\":{\"b\":1},\"c\":2}", "a"));
console.log("jsonMember nested arr = " + jsonMember("{\"a\":[1,2],\"c\":2}", "a"));
console.log("jsonMember absent     = [" + jsonMember("{\"a\":1}", "zz") + "]");
console.log("pickFields            = " + pickFields("{\"a\":1,\"b\":\"x\"}", ["a", "b", "nope"]));
