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

export type RpcRoute = { method: string, handler: string };

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

export function tableFault(routes: RpcRoute[]): string {
  if (routes.length == 0) { return "a class carrying @rpc must name at least one @method"; }
  let i: int = 0;
  while (i < routes.length) {
    if (routes[i].method == "") { return "a @method needs a name"; }
    let j: int = i + 1;
    while (j < routes.length) {
      if (routes[j].method == routes[i].method) {
        return "two methods answer \"" + routes[i].method + "\": " + routes[i].handler + " and " + routes[j].handler;
      }
      j = j + 1;
    }
    i = i + 1;
  }
  return "";
}

export function handlerFor(routes: RpcRoute[], method: string): string {
  let i: int = 0;
  while (i < routes.length) {
    if (routes[i].method == method) { return routes[i].handler; }
    i = i + 1;
  }
  return "";
}
