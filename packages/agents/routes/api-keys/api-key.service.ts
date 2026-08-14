import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { jsonText } from "../../scan.ts";
import { MintedKey } from "./dtos/minted-key.dto.ts";
import { ApiKeyRepository } from "./api-key.repository.ts";
import { ApiKeyAuth, ApiKeyMade, ApiKeyRow, MAX_KEYS_PER_OWNER, MAX_KEY_NAME, cleanScopes, emptyApiKey, looksLikeKey, scopeList, viewOf } from "./api-key.utils.ts";

export class ApiKeyService {
  repository: ApiKeyRepository;

  constructor(database: Db) {
    this.repository = new ApiKeyRepository(database);
  }

  listing(owner: string): string {
    let views = this.repository.listing(owner).map(viewOf);
    return JSON.stringify(views);
  }

  refuse(owner: string, name: string, scopes: string): string {
    if (owner == "") {
      return "signing in is what makes a key yours to keep";
    }
    if (name.trim() == "") {
      return "a key needs a name to be told apart from your others";
    }
    if (name.length > MAX_KEY_NAME) {
      return "\"" + name.slice(0, 20) + "...\" is too long a name";
    }
    if (scopes.trim() == "") {
      return "a key needs at least one product scope: search, retrieve or suggest";
    }
    if (this.repository.listing(owner).length >= MAX_KEYS_PER_OWNER) {
      return "that is " + `${MAX_KEYS_PER_OWNER}` + " keys already — revoke one before minting another";
    }
    return "";
  }

  mint(owner: string, name: string, scopesRaw: string, now: string): ApiKeyMade {
    let cleanName = name.trim();
    let scopes = cleanScopes(scopesRaw);
    let wrong = this.refuse(owner, cleanName, scopes);
    if (wrong != "") {
      let no: ApiKeyMade = { id: "", secret: "", prefix: "", fault: wrong };
      return no;
    }
    let prefix = "jl_" + crypto.randomBytes(4);
    let body = crypto.randomBytes(24);
    let secret = prefix + "_" + body;
    let hash = crypto.sha256(secret);
    let row: ApiKeyRow = {
      id: crypto.randomUUID(),
      owner: owner,
      name: cleanName,
      keyPrefix: prefix,
      keyHash: hash,
      scopes: scopes,
      createdAt: now,
      lastUsedAt: "",
    };
    let written = this.repository.save(row);
    if (!written.ok) {
      let no: ApiKeyMade = { id: "", secret: "", prefix: "", fault: written.error };
      return no;
    }
    let made: ApiKeyMade = { id: row.id, secret: secret, prefix: prefix, fault: "" };
    return made;
  }

  create(owner: string, body: string): Outcome {
    let made = this.mint(owner, jsonText(body, "name"), jsonText(body, "scopes"), stamp());
    if (made.fault != "") {
      return refusing(made.fault);
    }
    let minted: MintedKey = { id: made.id, secret: made.secret, keyPrefix: made.prefix };
    return produced(JSON.stringify(minted));
  }

  ownedBy(id: string, owner: string): ApiKeyRow {
    let row = this.repository.one(id);
    if (row.owner != owner) {
      return emptyApiKey();
    }
    return row;
  }

  forget(id: string, owner: string): bool {
    let row = this.ownedBy(id, owner);
    if (row.id == "") {
      return false;
    }
    return this.repository.remove(id).ok;
  }

  verify(secret: string): ApiKeyAuth {
    let miss: ApiKeyAuth = { ok: false, owner: "", keyId: "", scopes: [] };
    if (!looksLikeKey(secret)) {
      return miss;
    }
    let hash = crypto.sha256(secret);
    let row = this.repository.byHash(hash);
    if (row.id == "") {
      return miss;
    }
    let auth: ApiKeyAuth = {
      ok: true,
      owner: row.owner,
      keyId: row.id,
      scopes: scopeList(row.scopes),
    };
    return auth;
  }

  touch(id: string, now: string): void {
    this.repository.touch(id, now);
  }
}
