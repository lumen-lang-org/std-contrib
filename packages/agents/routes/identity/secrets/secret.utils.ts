import { destinationOf } from "../../../credentials.ts";

export function originOf(url: string): string {
  return destinationOf(url);
}

export const MAX_SECRETS_PER_OWNER: int = 20;
export const MAX_SECRET_NAME: int = 60;
export const MAX_SECRET_VALUE: int = 4096;

export type SecretRow = {
  id: string,
  owner: string,
  name: string,
  header: string,
  destination: string,
  category?: string,
  createdAt: string,
  lastUsedAt: string,
};

export function emptySecret(): SecretRow {
  let none: SecretRow = {
    id: "", owner: "", name: "", header: "", destination: "", category: "",
    createdAt: "", lastUsedAt: "",
  };
  return none;
}

export type SecretWrite = {
  owner: string,
  name: string,
  value: string,
  destination: string,
  header: string,
  category: string,
  master: string,
  now: string,
};

export type SecretMade = {
  id: string,
  fault: string,
};

export function secretRef(id: string): string {
  return "secret:" + id;
}
