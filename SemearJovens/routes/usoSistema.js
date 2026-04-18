const express = require('express');
const { pool } = require('../database');
const { getTenantId } = require('../lib/tenantIsolation');

const router = express.Router();

const LIMITE_GB = 50;
const LIMITE_BYTES = LIMITE_GB * 1024 * 1024 * 1024;

const MODULES = [
    {
        key: 'jovens',
        label: 'Cadastro de jovens',
        tables: [
            { name: 'jovens' },
            { name: 'historico_equipes' },
            { name: 'jovens_observacoes' },
            { name: 'jovens_comissoes' },
            { name: 'jovens_pastorais' },
            { name: 'jovens_atualizacao_comentarios' },
            { name: 'jovens_atualizacao_nao_encontrado' }
        ]
    },
    {
        key: 'tios',
        label: 'Tios',
        tables: [
            { name: 'tios_ecc' },
            { name: 'tios_casais' }
        ]
    },
    {
        key: 'outros_ejcs',
        label: 'Outros EJCs',
        tables: [
            { name: 'outros_ejcs' }
        ]
    },
    {
        key: 'edicoes_ejc',
        label: 'Edições do EJC',
        tables: [
            { name: 'ejc' }
        ]
    },
    {
        key: 'formularios',
        label: 'Eventos, Presenças e Inscrições',
        tables: [
            { name: 'formularios_pastas' },
            { name: 'formularios_itens' },
            { name: 'formularios_presencas' },
            { name: 'formularios_respostas' }
        ]
    },
    {
        key: 'moita',
        label: 'Moita',
        tables: [
            { name: 'moita_funcoes' },
            { name: 'moita_reservas', tenantJoin: { join: 'JOIN jovens j ON j.id = moita_reservas.jovem_id', where: 'j.tenant_id = ?' } }
        ]
    },
    {
        key: 'garcons',
        label: 'Garçons',
        tables: [
            { name: 'garcons_equipes' },
            { name: 'garcons_membros', tenantJoin: { join: 'JOIN jovens j ON j.id = garcons_membros.jovem_id', where: 'j.tenant_id = ?' } }
        ]
    },
    {
        key: 'arquivos',
        label: 'Arquivos',
        tables: [
            { name: 'pastas' },
            { name: 'arquivos' }
        ]
    },
    {
        key: 'usuarios',
        label: 'Usuários',
        tables: [
            { name: 'usuarios' }
        ]
    },
    {
        key: 'contatos',
        label: 'Contatos',
        tables: [
            { name: 'contatos_telefonicos' }
        ]
    }
];

async function tableExists(tableName) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?`,
        [tableName]
    );
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function hasColumn(tableName, columnName) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [tableName, columnName]
    );
    return !!(rows && rows[0] && rows[0].cnt > 0);
}

async function getTableInfo(tableName) {
    const [rows] = await pool.query(
        `SELECT DATA_LENGTH AS data_length,
                INDEX_LENGTH AS index_length
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
         LIMIT 1`,
        [tableName]
    );
    const row = rows && rows[0] ? rows[0] : null;
    const dataLength = Number(row && row.data_length ? row.data_length : 0);
    const indexLength = Number(row && row.index_length ? row.index_length : 0);
    return {
        bytes: dataLength + indexLength
    };
}

async function countRows(tableName, tenantId, rule) {
    if (rule && rule.tenantJoin) {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM ${tableName}
             ${rule.tenantJoin.join}
             WHERE ${rule.tenantJoin.where}`,
            [tenantId]
        );
        return Number(rows && rows[0] ? rows[0].total : 0);
    }
    const hasTenant = await hasColumn(tableName, 'tenant_id');
    if (!hasTenant) return null;
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM ${tableName}
         WHERE tenant_id = ?`,
        [tenantId]
    );
    return Number(rows && rows[0] ? rows[0].total : 0);
}

async function countTotalRows(tableName) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM ${tableName}`);
    return Number(rows && rows[0] ? rows[0].total : 0);
}

async function countRowsWhere(tableName, tenantId, whereSql, params = []) {
    const hasTenant = await hasColumn(tableName, 'tenant_id');
    const baseParams = hasTenant ? [tenantId, ...params] : [...params];
    const where = hasTenant ? `tenant_id = ?${whereSql ? ` AND ${whereSql}` : ''}` : (whereSql || '1=1');
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS total FROM ${tableName} WHERE ${where}`,
        baseParams
    );
    return Number(rows && rows[0] ? rows[0].total : 0);
}

async function buscarEdicaoAtual(tenantId) {
    const hasMontagens = await tableExists('montagens');
    if (hasMontagens) {
        const hasTenant = await hasColumn('montagens', 'tenant_id');
        const [rows] = await pool.query(
            `SELECT numero_ejc
             FROM montagens
             ${hasTenant ? 'WHERE tenant_id = ?' : ''}
             ORDER BY created_at DESC
             LIMIT 1`,
            hasTenant ? [tenantId] : []
        );
        if (rows && rows[0] && rows[0].numero_ejc !== undefined && rows[0].numero_ejc !== null) {
            return { numero: Number(rows[0].numero_ejc), origem: 'MONTAGEM' };
        }
    }

    const hasEjc = await tableExists('ejc');
    if (hasEjc) {
        const hasTenant = await hasColumn('ejc', 'tenant_id');
        const [rows] = await pool.query(
            `SELECT numero
             FROM ejc
             ${hasTenant ? 'WHERE tenant_id = ?' : ''}
             ORDER BY numero DESC
             LIMIT 1`,
            hasTenant ? [tenantId] : []
        );
        if (rows && rows[0] && rows[0].numero !== undefined && rows[0].numero !== null) {
            return { numero: Number(rows[0].numero), origem: 'EJC' };
        }
    }

    return null;
}

router.get('/', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const modulos = [];
        let totalEstimado = 0;
        let totalCompartilhado = 0;

        for (const mod of MODULES) {
            let tamanhoEstimado = 0;
            let tamanhoCompartilhado = 0;
            const detalhesTabelas = [];

            for (const table of mod.tables) {
                const exists = await tableExists(table.name);
                if (!exists) continue;

                const info = await getTableInfo(table.name);
                const totalRows = await countTotalRows(table.name);
                let tenantRows = await countRows(table.name, tenantId, table);

                if (tenantRows === null) {
                    tamanhoCompartilhado += info.bytes;
                    tamanhoEstimado += info.bytes;
                    detalhesTabelas.push({
                        tabela: table.name,
                        bytes: info.bytes,
                        tipo: 'COMPARTILHADO'
                    });
                    continue;
                }

                const proporcao = totalRows > 0 ? tenantRows / totalRows : 0;
                const estimado = info.bytes * proporcao;
                tamanhoEstimado += estimado;
                detalhesTabelas.push({
                    tabela: table.name,
                    bytes: estimado,
                    tipo: 'ESTIMADO',
                    linhas_tenant: tenantRows,
                    linhas_total: totalRows
                });
            }

            if (tamanhoEstimado <= 0 && tamanhoCompartilhado <= 0) continue;

            totalEstimado += tamanhoEstimado;
            totalCompartilhado += tamanhoCompartilhado;

            modulos.push({
                key: mod.key,
                label: mod.label,
                bytes: tamanhoEstimado,
                compartilhado_bytes: tamanhoCompartilhado,
                tabelas: detalhesTabelas
            });
        }

        const resumo = {};
        if (await tableExists('jovens')) {
            const hasOrigem = await hasColumn('jovens', 'origem_ejc_tipo');
            resumo.jovens = await countRowsWhere(
                'jovens',
                tenantId,
                hasOrigem ? "COALESCE(origem_ejc_tipo, 'INCONFIDENTES') <> 'OUTRO_EJC'" : ''
            );
            resumo.jovens_outro_ejc = hasOrigem
                ? await countRowsWhere('jovens', tenantId, "origem_ejc_tipo = 'OUTRO_EJC'")
                : 0;
        } else {
            resumo.jovens = 0;
            resumo.jovens_outro_ejc = 0;
        }

        resumo.tios = (await tableExists('tios_casais'))
            ? await countRowsWhere('tios_casais', tenantId, '')
            : 0;
        resumo.equipes = (await tableExists('equipes'))
            ? await countRowsWhere('equipes', tenantId, '')
            : 0;
        resumo.outros_ejcs = (await tableExists('outros_ejcs'))
            ? await countRowsWhere('outros_ejcs', tenantId, '')
            : 0;
        resumo.atas_reunioes = (await tableExists('ata_reunioes'))
            ? await countRowsWhere('ata_reunioes', tenantId, '')
            : 0;

        const hasPresencas = await tableExists('formularios_presencas');
        const hasItens = await tableExists('formularios_itens');
        if (hasPresencas && hasItens) {
            const colsOk = await Promise.all([
                hasColumn('formularios_presencas', 'tenant_id'),
                hasColumn('formularios_presencas', 'formulario_id'),
                hasColumn('formularios_presencas', 'nome_completo'),
                hasColumn('formularios_presencas', 'telefone'),
                hasColumn('formularios_presencas', 'status_ejc'),
                hasColumn('formularios_itens', 'id'),
                hasColumn('formularios_itens', 'tenant_id')
            ]);
            if (colsOk.every(Boolean)) {
                const [rows] = await pool.query(`
                    SELECT COUNT(*) AS total
                    FROM (
                        SELECT
                            LOWER(TRIM(fp.nome_completo)) AS nome_norm,
                            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(fp.telefone), ' ', ''), '(', ''), ')', ''), '-', ''), '+', '') AS telefone_norm
                        FROM formularios_presencas fp
                        JOIN formularios_itens fi
                          ON fi.id = fp.formulario_id
                         AND fi.tenant_id = fp.tenant_id
                        WHERE fp.tenant_id = ?
                          AND fp.status_ejc = 'NAO_FIZ'
                          AND COALESCE(TRIM(fp.nome_completo), '') <> ''
                          AND COALESCE(TRIM(fp.telefone), '') <> ''
                        GROUP BY nome_norm, telefone_norm
                        HAVING COUNT(DISTINCT fp.formulario_id) >= 3
                    ) t
                `, [tenantId]);
                resumo.visitantes = Number(rows && rows[0] ? rows[0].total : 0);
            } else {
                resumo.visitantes = 0;
            }
        } else {
            resumo.visitantes = 0;
        }

        resumo.edicao_atual = await buscarEdicaoAtual(tenantId);

        return res.json({
            limite_bytes: LIMITE_BYTES,
            limite_gb: LIMITE_GB,
            total_estimado_bytes: totalEstimado,
            total_compartilhado_bytes: totalCompartilhado,
            modulos,
            resumo,
            gerado_em: new Date().toISOString()
        });
    } catch (err) {
        console.error('Erro ao calcular uso do sistema:', err);
        return res.status(500).json({ error: 'Erro ao calcular uso do sistema.' });
    }
});

module.exports = router;
