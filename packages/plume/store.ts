// A mapping bound to a connection — Panache's repository, which is the thing
// you inject.
//
//   let agents = store(database, agentsMapping());
//   agents.findById("a1");
//   agents.list();
//   agents.persist(JSON.stringify(a));
//
// plume's operations take `(db, mapping, ...)` because that keeps them
// ordinary functions: testable, composable, and with nothing hidden. But a
// caller threading the same two values through every call is doing the
// compiler's job, and a controller holding both is holding one thing twice.
//
// A `Store` closes over them once. It adds no capability — every method is the
// same function with the first two arguments already supplied — so anything it
// does not cover is still reachable by calling plume directly with the `db`
// and `mapping` it carries.
//
// Named `Store` rather than `Repository` because `DbRepository` is already the
// mapping in this package. That is arguably the wrong name for a mapping, and
// Panache would call this one the repository; renaming the older type is a
// change worth making deliberately rather than in passing.

import { Db } from "./driver.ts";
import { DbField, DbOrder, DbQuery, DbRelation, DbRepository, DbResult, createTable, dropTable, persist, persistMany, findById, findProjected, listWhere, listProjected, listOrdered, pageOrdered, countWhere, existsById, deleteById, deleteWhere, createTableSql, createTableSqlWithKeys, foreignKeys } from "./plume.ts";

export type Store = {
  // What it was built from, so anything the methods below do not cover is
  // still one plume call away.
  db: Db,
  mapping: DbRepository,

  // Schema.
  createTable: () => DbResult,
  dropTable: () => DbResult,
  createTableSql: () => string,
  createTableSqlWithKeys: () => string,
  foreignKeys: () => string[],

  // Writing.
  persist: (document: string) => DbResult,
  persistMany: (documents: string) => DbResult,
  deleteById: (id: string) => DbResult,
  deleteWhere: (where: string, args: string[]) => DbResult,

  // Reading.
  findById: (id: string) => string,
  findProjected: (columns: string, id: string) => string,
  list: () => string,
  listWhere: (where: string, args: string[]) => string,
  listProjected: (columns: string, where: string, args: string[]) => string,
  listOrdered: (q: DbQuery) => string,
  pageOrdered: (q: DbQuery) => string,
  count: () => int,
  countWhere: (where: string, args: string[]) => int,
  existsById: (id: string) => bool,
};

export function store(db: Db, mapping: DbRepository): Store {
  let none: string[] = [];
  let s: Store = {
    db: db,
    mapping: mapping,

    createTable: () => { return createTable(db, mapping); },
    dropTable: () => { return dropTable(db, mapping); },
    createTableSql: () => { return createTableSql(db, mapping); },
    createTableSqlWithKeys: () => { return createTableSqlWithKeys(db, mapping); },
    foreignKeys: () => { return foreignKeys(db, mapping); },

    persist: (document: string) => { return persist(db, mapping, document); },
    persistMany: (documents: string) => { return persistMany(db, mapping, documents); },
    deleteById: (id: string) => { return deleteById(db, mapping, id); },
    deleteWhere: (where: string, args: string[]) => { return deleteWhere(db, mapping, where, args); },

    findById: (id: string) => { return findById(db, mapping, id); },
    findProjected: (columns: string, id: string) => { return findProjected(db, mapping, columns, id); },
    list: () => { return listWhere(db, mapping, "", none); },
    listWhere: (where: string, args: string[]) => { return listWhere(db, mapping, where, args); },
    listProjected: (columns: string, where: string, args: string[]) => { return listProjected(db, mapping, columns, where, args); },
    listOrdered: (q: DbQuery) => { return listOrdered(db, mapping, q); },
    pageOrdered: (q: DbQuery) => { return pageOrdered(db, mapping, q); },
    count: () => { return countWhere(db, mapping, "", none); },
    countWhere: (where: string, args: string[]) => { return countWhere(db, mapping, where, args); },
    existsById: (id: string) => { return existsById(db, mapping, id); },
  };
  return s;
}
