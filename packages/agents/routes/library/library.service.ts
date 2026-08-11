import { Db } from "../../../plume/driver.ts";
import { ArtifactCard, libraryFor } from "../../artifacts.ts";

export class LibraryService {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  cards(tags: string[]): ArtifactCard[] {
    return libraryFor(this.database, tags, 240);
  }
}
