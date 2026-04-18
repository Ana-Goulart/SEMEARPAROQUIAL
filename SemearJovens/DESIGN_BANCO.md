# Estrutura Relacional - EJC

## 📋 Resumo da Nova Estrutura

### **Tabelas**

1. **ejc**
   - Armazena cada edição do EJC (9º, 10º, 11º...)
   - Campos: `id`, `numero`, `paroquia`, `ano`
   - Exemplo: `(1, 9, 'Inconfidentes', 2022)`

2. **equipes**
   - Lista global de todas as equipes
   - Campos: `id`, `nome`, `descricao`
   - Exemplo: `(1, 'Cozinha', 'Refeições')`, `(2, 'Ordem', 'Disciplina')`

3. **equipes_ejc** *(N:N - Relacionamento)*
   - Liga qual EJC tem quais equipes
   - Campos: `id`, `ejc_id`, `equipe_id`
   - Permite que diferentes EJCs tenham diferentes equipes

4. **jovens** *(modificada)*
   - Adiciona `numero_ejc_fez` como FK para `ejc(id)`
   - Indica qual EJC o jovem **fez** (pode ser vazio se ainda não fez)

5. **historico_equipes** *(modificada)*
   - Adiciona `ejc_id` como FK para `ejc(id)`
   - Relaciona: Jovem → EJC → Equipe (histórico de serviço)

---

## 📊 Fluxo de Dados (Exemplo Real)

```
João fez o IX EJC e serviu em múltiplas equipes:
├─ IX EJC Inconfidentes
│  ├─ 2022: Cozinha
│  └─ 2022: Ordem
└─ X EJC Inconfidentes
   └─ 2023: Comunicação
```

**Queries SQL:**
```sql
-- Histórico completo de João (IX EJC)
SELECT he.*, eq.nome, e.numero 
FROM historico_equipes he
JOIN equipes eq ON he.equipe_id = eq.id
JOIN ejc e ON he.ejc_id = e.id
WHERE he.jovem_id = 1 AND he.ejc_id = 1;

-- Todas as equipes do IX EJC
SELECT eq.* FROM equipes eq
JOIN equipes_ejc ee ON eq.id = ee.equipe_id
JOIN ejc e ON ee.ejc_id = e.id
WHERE e.numero = 9;
```

---

## 🚀 Passo a Passo de Implementação

### **1. Rodar o SQL** (arquivo `schema_relacional.sql`)
```bash
mysql -u infra -p db_semeajovens < schema_relacional.sql
```

### **2. Migrar Dados Existentes** (se houver)
Se você já tem dados em `historico_equipes` com `edicao_ejc` (texto), será necessário:
- Criar mapping entre `edicao_ejc` (ex: "IX EJC") e `ejc.id`
- Inserir equipes em falta na tabela `equipes`
- Atualizar `historico_equipes` com os IDs corretos

**Script de migração (exemplo):**
```sql
-- Se a coluna edicao_ejc tem valores tipo "IX EJC Inconfidentes"
UPDATE historico_equipes he
SET he.ejc_id = e.id
FROM ejc e
WHERE CONCAT(e.numero, ' EJC') LIKE CONCAT('%', SUBSTRING_INDEX(he.edicao_ejc, ' ', 1), '%');
```

### **3. Atualizar Estrutura de `jovens`**
```sql
-- Se coluna numero_ejc_fez não existe
ALTER TABLE jovens 
ADD COLUMN numero_ejc_fez INT,
ADD FOREIGN KEY (numero_ejc_fez) REFERENCES ejc(id);
```

### **4. Revisar `historico_equipes`**
- Certificar que tem `ejc_id`
- Adicionar `equipe_id` se quiser referência direta à tabela `equipes`
- Remover coluna `edicao_ejc` (agora redundante)

---

## 🎯 Vantagens Dessa Estrutura

✅ **Normalização**: Sem repetição de dados (ex: paróquia não é duplicada)  
✅ **Flexibilidade**: Diferentes EJCs podem ter equipes diferentes  
✅ **Histórico**: Rastreia exatamente qual jovem serviu em qual equipe em qual EJC  
✅ **Escalabilidade**: Fácil adicionar novos EJCs ou equipes  
✅ **Consistência**: FK garante que não sobra dados órfãos  

---

## 🔄 Alternativa Simplificada (Se Preferir)

Se quiser **não** ter a tabela `equipes_ejc`, pode simplificar:
- Tabela `equipes` com lista global de equipes
- `historico_equipes` com: `jovem_id`, `ejc_id`, `equipe_id`
- Assume que as mesmas equipes existem em todos os EJCs

Menos flexível, mas mais simples.

---

## 📝 Próximas Ações

1. ✅ Revisar estrutura acima
2. 🔧 Testar o SQL (`schema_relacional.sql`)
3. 📡 Atualizar rotas Node.js para usar novas FKs
4. 🎨 Atualizar front-end para puxar dados via novas queries

