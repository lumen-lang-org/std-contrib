// The shapes the connect routes read and write.

// The two halves of an OAuth client, as PUT /connect/:id/client is given them.
export type SuppliedClientAsk = {
  clientId: string,
  clientSecret: string,
};
