# Instrucoes Gerais Do Workspace

Este workspace contem varios projetos relacionados. Sempre interprete os diretorios abaixo desta forma, independentemente do contexto atual da conversa:

- `/SemearParoquial/SemearCore`: projeto core
- `/SemearParoquial/SemearJovens`: projeto EJC
- `/SemearParoquial/SemearAdmin`: projeto admin
- `/SemearParoquial/SemearCatequese`: projeto de catequese
- `/SemearParoquial/SemearLogin`: projeto de login responsavel por acessar os modulos

Regras de interpretacao:

- Quando o usuario mencionar "core", considere `SemearCore`
- Quando o usuario mencionar "ejc", considere `SemearJovens`
- Quando o usuario mencionar "admin", considere `SemearAdmin`
- Quando o usuario mencionar "catequese", considere `SemearCatequese`
- Quando o usuario mencionar "login", considere `SemearLogin`
- Se houver ambiguidade, use esse mapeamento como padrao antes de assumir qualquer outra pasta

Padrao geral para frontend:

- Em todos os projetos deste workspace, qualquer tarefa de frontend deve seguir a abordagem mobile-first como padrao
- Comece layouts, estilos e componentes pela experiencia em telas menores e depois expanda para tablet e desktop
- Ao implementar responsividade, trate mobile como base e use breakpoints progressivos para telas maiores

Padrao obrigatorio para menus e permissoes:

- Sempre que for criado um menu novo na raiz/navegacao do sistema, adicione esse menu tambem em `SemearJovens/views/funcoes-dirigencia.html`
- O menu novo deve aparecer dentro da configuracao de cada funcao da dirigencia, permitindo escolher se os usuarios vinculados poderao apenas visualizar ou tambem editar esse menu
- Ao adicionar o menu na configuracao de funcoes, mantenha a mesma chave/identificador usada pela navegacao para que as permissoes funcionem de forma consistente

Padrao obrigatorio para banco de dados:

- Toda alteracao de estrutura de banco deve ser feita por migration versionada em `migrations/<nome_do_banco>/`
- Considere alteracao de estrutura: criar/alterar/remover tabelas, colunas, indices, constraints, chaves estrangeiras, views, triggers, procedures e dados estruturais obrigatorios para o funcionamento do sistema
- Nao altere estrutura de banco apenas por comando manual direto, script avulso ou arquivo `setup_*.js` sem tambem criar a migration correspondente
- Se uma tarefa exigir mudanca no banco `semear_paroquial_homo` ou equivalente de producao, use `migrations/semear_paroquial/`
- Antes de aplicar migrations, rode o modo de verificacao quando existir, por exemplo `npm run migrate:semear-paroquial:dry`
- Depois de criar uma migration, aplique em homologacao com o comando apropriado, por exemplo `npm run migrate:semear-paroquial`, salvo se o usuario pedir explicitamente para nao aplicar
- Nunca edite uma migration que ja foi executada em algum ambiente; crie uma nova migration com o proximo numero sequencial
- Ao finalizar uma tarefa que mexeu em banco, informe quais migrations foram criadas e qual comando de migracao foi executado
