# Concilia Pix

Aplicação de conciliação Pix em React, TypeScript e Vite, com área autenticada conectada ao backend NestJS e demonstração pública isolada.

## Executar localmente

Com Node.js 20.19+ ou 22.12+:

```sh
npm ci
npm run dev
```

Abra o endereço exibido pelo Vite. Para verificar os tipos e gerar o build, execute `npm run build`.

## Painel e demonstração

A raiz e a área autenticada usam os mesmos componentes de interface. Na demonstração, o adaptador em `src/demo-api.ts` usa dados fictícios em memória que reiniciam ao recarregar a página. A sessão autenticada consulta as APIs da empresa ativa e o backend administra persistência, permissões e cache.

## Identidade e confirmação de e-mail

O backend em TypeScript e NestJS roda em `backend/`. PostgreSQL guarda usuários,
tokens de confirmação e a fila transacional de envio. A identidade fica no escopo da aplicação. Os vínculos e papéis determinam o acesso a cada empresa.

### Ambiente local

Use Node.js 22.12+ ou 24 e Docker Compose. O PostgreSQL local usa a porta
`55432`. O Mailpit recebe SMTP na porta `11025` e tem caixa de entrada em
[localhost:18025](http://localhost:18025). As portas do Compose são vinculadas
ao loopback.

Na raiz, se `backend/.env` ainda não existir, crie o arquivo a partir do
exemplo. Gere uma senha do PostgreSQL e uma chave de 32 bytes usando um
gerador criptográfico. Este exemplo usa PowerShell:

```powershell
if (!(Test-Path backend/.env)) {
  $pixDbPassword = node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
  $pixMailKey = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
  $pixLoginKey = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
  $pixDatabaseUrl = "postgresql://conciliapix:${pixDbPassword}@127.0.0.1:55432/conciliapix"
  $pixConfig = Get-Content -Raw backend/.env.example
  $pixConfig.Replace('POSTGRES_PASSWORD=', "POSTGRES_PASSWORD=$pixDbPassword").Replace('DATABASE_URL=', "DATABASE_URL=$pixDatabaseUrl").Replace('CONFIRMATION_KEYS=', "CONFIRMATION_KEYS=local:$pixMailKey").Replace('LOGIN_RATE_KEY=', "LOGIN_RATE_KEY=$pixLoginKey") | Set-Content -Encoding ascii backend/.env
}
docker compose -p conciliapix-identity --env-file backend/.env -f compose.identity.yml up -d --wait
npm ci
npm --prefix backend ci
npm --prefix backend run build
npm --prefix backend run migrate
npm --prefix backend start
```

Em outro terminal, execute `npm run dev` na raiz e abra
[localhost:5173/cadastro](http://localhost:5173/cadastro). A confirmação e o
reenvio estão em `/confirmar-email`. O Vite encaminha `/api/identity` para
`http://127.0.0.1:3000` localmente.

### Configuração

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL. Em produção, configure TLS verificável conforme o provedor. |
| `POSTGRES_PASSWORD` | Senha solicitada pelo Compose local para inicializar o volume. |
| `PUBLIC_CONFIRMATION_URL` | URL pública completa da tela, sem consulta nem fragmento. HTTPS em produção. |
| `CONFIRMATION_KEYS` | Mapa `id:chave_base64url` de chaves de 32 bytes, separado por vírgulas. Mantenha em um cofre de segredos. |
| `CONFIRMATION_ACTIVE_KEY` | Identificador usado para novas emissões. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | Servidor e remetente. `SMTP_USER` e `SMTP_PASSWORD` são opcionais e usados em conjunto. |
| `SMTP_SECURE` | `true` para TLS implícito. Em produção, a conexão deve usar TLS, inclusive quando negociado via STARTTLS. |
| `NODE_ENV`, `HOST`, `PORT` | Use `NODE_ENV=production` para exigir HTTPS na API. O padrão local é `127.0.0.1:3000`. |
| `TRUSTED_PROXIES` | IPs ou CIDRs de proxies confiáveis, separados por vírgulas. Configure apenas os proxies que sobrescrevem os cabeçalhos encaminhados. |
| `IDENTITY_API_ORIGIN` | Destino opcional do proxy Vite para desenvolvimento e prévia. |
| `TEST_DATABASE_URL` | Banco PostgreSQL de testes. A conta precisa poder criar e remover um schema isolado. |

Em produção, sirva a aplicação e a API na mesma origem, encaminhe
`/api/identity/*` ao NestJS e sirva o HTML do frontend em `/confirmar-email`
e `/cadastro`. Configure a terminação HTTPS e evite registrar corpos das
requisições no proxy, na aplicação e na instrumentação. Não use Mailpit
como transporte de produção.

### API

As rotas usam JSON com respostas sem cache. Erros têm `code` e `message`.

| Método e rota | Corpo | Resultado |
| --- | --- | --- |
| POST `/api/identity/register` | `name`, `email`, `password` | `202` genérico, inclusive para e-mail já cadastrado. |
| POST `/api/identity/confirm` | `token` | `200` confirmado, `400 INVALID_TOKEN`, `410 TOKEN_EXPIRED` ou `409 TOKEN_USED`. |
| POST `/api/identity/resend` | `email` | `202` genérico para conta inexistente, confirmada, pendente ou limitada por conta. |

Entradas inválidas recebem `400`. O limite por IP usa janelas de 15 minutos
no PostgreSQL e retorna `429 RATE_LIMITED`. São 10 tentativas de cadastro,
30 de confirmação e 20 de reenvio por janela. O intervalo mínimo por conta
é de 60 segundos e o limite é de cinco reenvios em uma hora. E-mails são
aparados e convertidos para minúsculas, com validação de endereço ASCII.
Use a forma punycode para domínios internacionalizados.

### Tokens, rotação e recuperação

O token de 24 horas é derivado por HMAC-SHA-256, com separação por finalidade,
a partir de um identificador aleatório do registro e de uma chave versionada.
A API valida somente o hash SHA-256 do token. A fila guarda o identificador do
registro, permitindo que o worker reconstitua o mesmo link depois do commit.
O link leva o token no fragmento, que a tela remove da barra de endereço antes
de enviar o token no corpo da solicitação explícita de confirmação.

Na rotação planejada, distribua a chave nova junto da anterior para todas as
instâncias antes de ativar a nova. Mantenha a anterior enquanto existirem
envios pendentes ou recuperáveis com tokens válidos daquela versão. Links
já enviados continuam validáveis pelo hash até serem consumidos, expirarem
ou serem invalidados. Em caso de comprometimento, invalide os tokens ativos
da versão afetada e emita novos links via reenvio.

A fila tenta até cinco entregas automáticas, com espera crescente. Falhas
guardam uma categoria fixa e o cadastro permanece pendente. Um operador pode
consultar o identificador de um envio falho e reprogramá-lo enquanto o token
estiver válido:

```powershell
npm --prefix backend start -- recover-mail <token_id_do_registro>
```

Uma falha entre o aceite SMTP e o registro final pode levar a outro envio
do mesmo link. O consumo do token continua limitado a uma confirmação.

### Verificações

Execute `npm run build` na raiz. Para os testes de integração, defina
`TEST_DATABASE_URL` no ambiente ou em `backend/.env.test` e execute
`npm --prefix backend test`. Os testes usam um schema isolado no PostgreSQL
e um transporte controlado para simular falhas e recuperação.

## Login e sessões

Abra [localhost:5173/entrar](http://localhost:5173/entrar) depois de iniciar a API
e o frontend. Cadastro e confirmação continuam públicos. A rota `/app` consulta a sessão e abre a seleção de empresas. `/conta` continua disponível como endereço alternativo. O painel na raiz é uma demonstração
pública com dados fictícios em memória. A área autenticada usa a API e exige vínculo ativo com a empresa.

Se estiver atualizando um ambiente anterior, gere uma chave de 32 bytes em
base64url para `LOGIN_RATE_KEY` no `backend/.env` e execute o build e
`npm --prefix backend run migrate` antes de reiniciar a API. A migração
`002_sessions.sql` adiciona a tabela de sessões e preserva os usuários.
O comando abaixo gera o valor da chave em uma variável para preencher o
arquivo sem imprimi-la:

```powershell
$pixLoginKey = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

| Variável | Uso |
| --- | --- |
| `LOGIN_RATE_KEY` | Chave privada de 32 bytes em base64url para os identificadores dos limites. Compartilhe a mesma chave entre instâncias da API. |
| `IDENTITY_WEB_ORIGINS` | Lista explícita de origens separadas por vírgula, com esquema e porta, sem caminho ou barra final. Se omitida, usa a origem de `PUBLIC_CONFIRMATION_URL`. Produção exige HTTPS. |

Sirva `/entrar` e `/conta` com o HTML do frontend, além das rotas públicas de
identidade. Mantenha o frontend e a API na mesma origem via proxy, ou em
origens distintas do mesmo site explicitamente configuradas em CORS. O
cookie é restrito ao host da API. Em desenvolvimento com proxy Vite, o
navegador vê o host do Vite. Em produção, configure o proxy confiável e
remova `Cookie` e `Set-Cookie` dos logs e instrumentação.

### Endpoints de sessão

| Método e rota | Corpo | Resultado |
| --- | --- | --- |
| POST `/api/identity/login` | `email`, `password` | `204` e cookie de sessão. `401 INVALID_CREDENTIALS` para credenciais inválidas, `403 EMAIL_UNCONFIRMED` para senha correta com e-mail pendente, `409 SESSION_REPLACED` para renovação concorrente e `429 LOGIN_RATE_LIMITED` para excesso de tentativas. |
| GET `/api/identity/session` | — | `200` com `user: { id, name, email }`, ou `401` com `SESSION_REQUIRED` ou `SESSION_INVALID`. A API limpa o cookie quando identifica uma sessão inválida. |
| POST `/api/identity/logout` | `{}` | `204`, revogação no PostgreSQL e remoção do cookie. Pode ser repetido. |

Login e logout exigem JSON, `Origin` permitido e o cabeçalho
`X-ConciliaPix-CSRF: 1`. A origem exata e o cabeçalho em conjunto bloqueiam
envios por formulários simples e exigem preflight para requisições CORS.
O cabeçalho é um marcador de contrato. A origem e o navegador fornecem a
proteção. A consulta de sessão recusa acesso sem origem declarada quando
`Sec-Fetch-Site` indica outra origem.

A sessão usa 256 bits aleatórios no cookie, com `HttpOnly`, `SameSite=Lax`
e `Path=/`. Em produção o cookie usa `Secure` e o prefixo `__Host-`.
O servidor guarda somente o hash. A validade é de 12 horas desde o login,
com expiração após 30 minutos sem uso. A consulta autenticada atualiza o
prazo de inatividade até o limite absoluto. Um login válido substitui a
sessão apresentada pelo navegador em uma transação. Se dois logins
apresentarem o mesmo cookie, a resposta perdedora retorna `409` e preserva o
cookie emitido pela vencedora. Sessões de outros dispositivos são
independentes e sobrevivem ao reinício da API.

O PostgreSQL compartilha os limites de login entre instâncias: 30
tentativas por IP e 8 por par IP e e-mail normalizado em uma janela fixa
de 15 minutos. Tentativas rejeitadas não estendem a janela. Um terceiro
em outro IP não consegue bloquear globalmente o login de uma conta.
Conta inexistente passa pela verificação Argon2id de um hash fictício,
com os mesmos parâmetros de cadastro. O limite por par também vale
para e-mails inexistentes.




## Operação multitenant

Entre em [localhost:5173/entrar](http://localhost:5173/entrar) e selecione
**Acessar empresas**. Uma identidade confirmada pode criar ou participar de
várias empresas. A empresa ativa fica no endereço em `/app?empresa=…` e cada
requisição confere novamente o vínculo ativo e o papel no PostgreSQL. A
demonstração pública da raiz mantém seu estado fictício isolado.

A migração `003_multitenant.sql` preserva identidades, sessões e tokens de
confirmação existentes. Siga os comandos do ambiente local acima e execute
`npm --prefix backend run build` e `npm --prefix backend run migrate` antes
de reiniciar a API. O worker de e-mail é iniciado junto com
`npm --prefix backend start`. O Mailpit captura confirmação, recuperação e
convites em [localhost:18025](http://localhost:18025).

Para habilitar o simulador local, gere 32 bytes aleatórios em base64url e
configure `SIMULATOR_SECRET` no `backend/.env`. A chave é exclusiva do backend.
A API habilita o webhook simulado somente fora do modo produção e quando a
chave existe. O simulador autorizado envia HTTP ao webhook local, que
autentica o emissor e identifica a empresa pela conta de provedor cadastrada.
Cada empresa recebe uma conta simulada ao ser criada. Não é necessário
carregar dados fictícios na área autenticada. Use o simulador explicitamente
para produzi-los. Em produção, mantenha o simulador desabilitado.

### Matriz aprovada

| Papel | Operações financeiras | Empresa | Equipe |
| --- | --- | --- | --- |
| Proprietário | Leitura, criação, simulação e decisão de revisão | Consulta e edição | Convida e gerencia todos os papéis, com proteção do último proprietário ativo |
| Administrador | Leitura, criação, simulação e decisão de revisão | Consulta e edição | Consulta equipe e gerencia somente financeiro e consulta |
| Financeiro | Leitura, criação, simulação e decisão de revisão | Consulta | Sem gestão de equipe |
| Consulta | Leitura | Consulta | Sem gestão de equipe |

Os convites expiram em sete dias e exigem sessão com o mesmo e-mail
confirmado. Para convidado sem cadastro, mantenha a tela de convite aberta,
conclua cadastro, confirmação e login em outra aba e retorne para aceitar.
Reenviar invalida o link anterior. Revogar invalida o link atual.
A empresa e o vínculo inicial são gravados na mesma transação. A criação
aceita um `requestKey` UUID para repetir a mesma operação com segurança.

### Operações e dados

- Recuperação em `/recuperar-senha` e `/redefinir-senha`. O link dura
  30 minutos e usa hash e finalidade separados. Redefinir ou alterar senha
  atualiza a versão da credencial, revoga todas as sessões e invalida os
  demais links de recuperação em uma transação. A autenticação compara
  novamente essa versão sob bloqueio antes de emitir uma sessão. A troca de
  senha preserva o estado de confirmação do e-mail.
- Listas operacionais, empresas e equipe aceitam `q` e `page`, com até 20 registros por
  página. Cobranças, eventos e revisões aceitam `filter`. Dados são da empresa
  no caminho, independentemente de identificadores enviados pelo cliente.
- Valores são inteiros em centavos de BRL, entre 1 e 1.000.000.000 por
  pagamento/cobrança. Datas no banco são `timestamptz`. A interface e o
  agrupamento diário usam `America/Sao_Paulo`. O total conciliado soma
  pagamentos com baixa pelo valor efetivamente recebido, e o total a
  receber soma o valor nominal das cobranças pendentes.
- Um pagamento distinto com valor exato dá baixa em uma cobrança pendente.
  Divergência e extra abrem revisão. Um pagamento sem cobrança gera
  ocorrência rastreável. A mesma chave externa e o mesmo conteúdo registram
  reenvio sem efeito financeiro. Conteúdo conflitante registra a tentativa
  e retorna `409`. O simulador reaproveita a chave numa tentativa repetida
  após erro de comunicação.
- Revisões podem ser encerradas com justificativa, ter baixa manual após
  aceitar divergência em cobrança pendente ou receber registro de devolução
  já feita externamente. A devolução registrada é uma decisão de auditoria
  e não cria movimentação financeira no sistema. A ocorrência mantém valores
  originais, autor e data.
- A auditoria guarda autor ou origem, empresa quando aplicável, alvo,
  resultado e correlação. `X-Request-Id` ajuda a localizar a requisição.
  A tabela bloqueia UPDATE, DELETE e TRUNCATE por trigger. Em produção,
  use uma conta de migração separada e conceda à conta da API somente as
  permissões necessárias, sem DDL ou propriedade das tabelas.
- O cache PostgreSQL tem TTL de 45 segundos. As chaves incluem empresa e
  filtros. Uma alteração incrementa a versão na mesma transação. O cache só
  responde após a validação de vínculo e papel. Falhas da tabela de cache
  usam a consulta original, e decisões de pagamento consultam as tabelas
  transacionais. O log agregado `tenant_cache` expõe acertos, ausências,
  erros e milissegundos acumulados de carregamento por processo. Compare a
  latência dos endpoints e a razão de acertos antes de adotar outro serviço.

### Rotas adicionadas

Todas as operações autenticadas de escrita usam a mesma proteção de origem
e CSRF do login. As rotas de recuperação usam JSON, limites e o token de uso
único ao confirmar.

| Rotas | Uso |
| --- | --- |
| POST `/api/identity/password/request`, `/password/reset` | Solicitar recuperação e salvar a nova senha |
| POST `/api/identity/password/change`, `/profile`, `/sessions/revoke-others` | Segurança e perfil autenticados |
| GET/POST `/api/tenant/companies` | Listar empresas e criar vínculo inicial |
| GET/POST `/api/tenant/companies/:company` | Consultar e atualizar empresa |
| GET `/api/tenant/companies/:company/team` | Membros e convites |
| POST `/api/tenant/companies/:company/invites`, `/invites/:id/:action`, `/members/:id` | Convidar, reenviar, revogar e atualizar vínculo |
| POST `/api/tenant/invites/accept` | Aceitar convite para o e-mail da sessão |
| GET `/api/tenant/companies/:company/overview` | Indicadores, recebimentos e atividade |
| GET `/api/tenant/companies/:company/:kind` e `/:kind/:id` | Listar e consultar clientes, cobranças, eventos e revisões |
| POST `/api/tenant/companies/:company/clients`, `/charges`, `/reviews/:id/resolve` | Criar registros e decidir revisões |
| POST `/api/tenant/companies/:company/clients/:id` | Atualizar nome e e-mail de um cliente da empresa |
| POST `/api/tenant/companies/:company/simulate` e `/api/tenant/webhook/simulator` | Disparar e receber entregas simuladas |

Configure o proxy de produção também para `/api/tenant/*`. Sirva o HTML do
frontend em `/app`, `/aceitar-convite`, `/recuperar-senha` e
`/redefinir-senha`. Preserve HTTPS, cookies, origens explícitas e SMTP
autenticado conforme as seções anteriores. Integração com provedor financeiro
real e deploy dependem de decisão posterior.

### Backup e restauração local

Exemplo com Docker Compose, usando arquivo no contêiner para evitar
redirecionamento binário no PowerShell antigo. Armazene o backup e as chaves
de confirmação em local protegido, com controles separados.

```powershell
docker compose -p conciliapix-identity --env-file backend/.env -f compose.identity.yml exec -T postgres pg_dump -U conciliapix -Fc -f /tmp/conciliapix.dump conciliapix
docker compose -p conciliapix-identity --env-file backend/.env -f compose.identity.yml cp postgres:/tmp/conciliapix.dump ./conciliapix.dump
docker compose -p conciliapix-identity --env-file backend/.env -f compose.identity.yml exec -T postgres createdb -U conciliapix conciliapix_restore
docker compose -p conciliapix-identity --env-file backend/.env -f compose.identity.yml cp ./conciliapix.dump postgres:/tmp/conciliapix-restore.dump
docker compose -p conciliapix-identity --env-file backend/.env -f compose.identity.yml exec -T postgres pg_restore -U conciliapix --exit-on-error -d conciliapix_restore /tmp/conciliapix-restore.dump
```

Confira integridade em banco separado antes de trocar a conexão. Os testes
de domínio rodam junto com os testes de identidade via
`npm --prefix backend test`, em um schema isolado. Execute
`npm run build` para checagem de tipos e build do frontend.



