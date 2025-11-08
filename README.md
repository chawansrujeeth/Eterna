## Postman & Insomnia

- Import **postman_collection.json**. Hit **Create Market Order**; the `Tests` tab stores `orderId` in your environment.
- For WebSocket streaming, either:
  - In **Insomnia**, import **insomnia_collection.json**, run POST, copy the `orderId` into env, then start the WS request.
  - Or run: `npm run ws -- <orderId>`.
