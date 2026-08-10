import { RpcRoute } from "./rpc.ts";

export type RpcDecoratorUse = { name: string, args: string[] };
export type RpcMethodNote = { name: string, returns: string, decorators: RpcDecoratorUse[] };
export type RpcFieldNote = { name: string, type: string };
export type Description = {
  protocol: int,
  kind: string,
  name: string,
  args: string[],
  fields: RpcFieldNote[],
  methods: RpcMethodNote[],
};

export function rpc(d: Description): RpcRoute[] {
  let out: RpcRoute[] = [];
  let i: int = 0;
  while (i < d.methods.length) {
    let m = d.methods[i];
    let j: int = 0;
    while (j < m.decorators.length) {
      let dec = m.decorators[j];
      if (dec.name == "method" && dec.args.length > 0 && dec.args[0] != "") {
        out.push({ method: dec.args[0], handler: m.name });
      }
      j = j + 1;
    }
    i = i + 1;
  }
  return out;
}

