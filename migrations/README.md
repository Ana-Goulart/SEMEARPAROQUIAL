# Migrations do Semear Paroquial

As migrations ficam na raiz e sao organizadas por banco, nao por modulo.

## Banco principal do EJC/Login

Use:

```bash
npm run migrate:semear-paroquial:dry
npm run migrate:semear-paroquial
```

Por padrao esse comando le `SemearLogin/.env`, entao ele aplica as migrations no banco definido em `DB_NAME`.

No ambiente de producao, o mesmo comando deve ser executado com o `.env` de producao:

```bash
node scripts/migrate.js --database semear_paroquial --env SemearLogin/.env --dry-run
node scripts/migrate.js --database semear_paroquial --env SemearLogin/.env
```

## Como criar uma migration nova

Crie um arquivo SQL com prefixo numerico crescente:

```text
migrations/semear_paroquial/000002_add_ultimo_login_usuarios.sql
```

Depois rode em homologacao:

```bash
npm run migrate:semear-paroquial:dry
npm run migrate:semear-paroquial
```

Quando estiver aprovado, suba o mesmo arquivo para producao e execute o mesmo comando la.

Nao edite uma migration que ja rodou em algum ambiente. Crie uma nova migration.
