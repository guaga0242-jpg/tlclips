# TLClips — versão pronta para Vercel

Loja gamer TLClips com frontend + backend no mesmo projeto.

## Recursos
- catálogo vindo do backend;
- carrinho e checkout;
- preço, estoque e frete recalculados no servidor;
- Pix manual;
- pedidos persistidos em Vercel Blob privado;
- acompanhamento de pedido;
- painel `/admin.html` protegido por `ADMIN_KEY`;
- Mercado Pago opcional via `MERCADO_PAGO_ACCESS_TOKEN`.

## Publicação no Vercel
Use um Vercel Blob privado conectado ao projeto. O botão de deploy sugerido pelo ChatGPT já solicita essa criação automaticamente.

A chave Pix padrão está configurada no backend para a chave informada pelo dono da loja. Se quiser alterar, defina `PIX_KEY` nas variáveis de ambiente do Vercel.

Para ativar o painel administrativo, crie a variável de ambiente `ADMIN_KEY` com uma senha forte e faça um novo deploy.

Para ativar Mercado Pago, adicione `MERCADO_PAGO_ACCESS_TOKEN` e faça novo deploy.
