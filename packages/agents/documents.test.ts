import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { documentFilesPlan } from "./document-files.ts";
import { DocumentService } from "./routes/knowledge/documents/document.service.ts";
import { DocumentStored } from "./routes/knowledge/documents/dtos/document-stored.dto.ts";
import { DocumentSummary } from "./routes/knowledge/documents/dtos/document-summary.dto.ts";
import { keptSummary, listedAlready } from "./routes/knowledge/documents/document.utils.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_documents_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS document_files");
  migrate(database, documentFilesPlan(database));
}

function kept(source: string, filename: string): string {
  return "{\"source\":\"" + source + "\",\"scope\":\"/specs\",\"filename\":\"" + filename
    + "\",\"mime\":\"application/pdf\",\"contentBase64\":\"aGVsbG8=\"}";
}

test("a file kept without an embedding model is kept, and says it is not searchable", () => {
  fresh();
  let documents = new DocumentService(database, "0123456789abcdef0123456789abcdef");
  let out = documents.keepFile("", "", kept("contract", "contract.pdf"));

  expect(out.fault == "");
  let stored = JSON.parse<DocumentStored>(out.document);
  expect(stored.stored);
  expect(!stored.indexed);
  expect(stored.note.indexOf("not searchable") > 0);
});

test("a kept file is on the page even with nothing of it in the corpus", () => {
  fresh();
  let documents = new DocumentService(database, "0123456789abcdef0123456789abcdef");
  documents.keepFile("", "", kept("contract", "contract.pdf"));

  // It used to be listed from the corpus alone, so a document nobody could
  // read disappeared the moment it was uploaded — which reads as a failed
  // upload rather than as a file that cannot be searched.
  let listed = documents.listing("", "/specs");
  expect(listed.length == 1);
  expect(listed[0].source == "contract");
  expect(listed[0].status == "kept");
  expect(listed[0].chunks == 0);
  expect(listed[0].hasFile);
});

test("a folder with nothing in it lists nothing", () => {
  fresh();
  let documents = new DocumentService(database, "0123456789abcdef0123456789abcdef");
  documents.keepFile("", "", kept("contract", "contract.pdf"));

  expect(documents.listing("", "/elsewhere").length == 0);
});

test("a kept file is named once, whatever else the corpus knows about it", () => {
  let shown: DocumentSummary[] = [keptSummary("contract", "/specs")];
  expect(listedAlready(shown, "contract"));
  expect(!listedAlready(shown, "invoice"));
  expect(shown[0].scope == "/specs");
  expect(shown[0].status == "kept");
  expect(shown[0].hasFile);
});
