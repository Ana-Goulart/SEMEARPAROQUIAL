const { pool } = require('../database');

const TENANT_NAME = 'INCONFIDENTES';
const TOTAL_CASAIS = 20;
const SEED_TAG = 'seed_tios_inconfidentes_paginacao_v1';

const nomesTio = [
    'Carlos', 'Marcos', 'Ronaldo', 'Luciano', 'Paulo', 'Fernando', 'Eduardo', 'Roberto', 'Anderson', 'Fabio',
    'Ricardo', 'Sergio', 'Leandro', 'Alexandre', 'Gustavo', 'Vinicius', 'Rafael', 'Thiago', 'Bruno', 'Mateus'
];

const nomesTia = [
    'Patricia', 'Rosangela', 'Juliana', 'Mariana', 'Cristiane', 'Aline', 'Carla', 'Renata', 'Silvania', 'Priscila',
    'Fernanda', 'Tatiane', 'Luciana', 'Michele', 'Simone', 'Vanessa', 'Daniela', 'Camila', 'Bianca', 'Flavia'
];

const sobrenomes = [
    'Silva', 'Souza', 'Oliveira', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Ferreira', 'Gomes',
    'Martins', 'Araujo', 'Ribeiro', 'Carvalho', 'Melo', 'Barbosa', 'Moreira', 'Teixeira', 'Rocha', 'Correia'
];

function pad(value) {
    return String(value).padStart(2, '0');
}

function montarData(seq, anoBase) {
    const ano = anoBase + (seq % 8);
    const mes = ((seq + 2) % 12) + 1;
    const dia = ((seq * 3) % 27) + 1;
    return `${ano}-${pad(mes)}-${pad(dia)}`;
}

function montarDataHoraAceite(seq) {
    const dia = ((seq * 2) % 27) + 1;
    const hora = 8 + (seq % 10);
    const minuto = 10 + (seq % 40);
    return `2026-03-${pad(dia)} ${pad(hora)}:${pad(minuto)}:00`;
}

function montarTelefone(seq, base) {
    const numero = String(base + seq).slice(-9);
    return `(31)${numero.slice(0, 5)}-${numero.slice(5)}`;
}

function montarNomeCompleto(primeiroNome, seq, deslocamento) {
    const sobrenomeA = sobrenomes[(seq - 1 + deslocamento) % sobrenomes.length];
    const sobrenomeB = sobrenomes[(seq + deslocamento + 5) % sobrenomes.length];
    return `${primeiroNome} ${sobrenomeA} ${sobrenomeB}`;
}

async function ensureEncontros(connection, tenantId) {
    const definicoes = [
        { numero: '1', tipo: 'ECC', descricao: 'ECC Inconfidentes - Casais base' },
        { numero: '2', tipo: 'ECC', descricao: 'ECC Inconfidentes - Casais caminhada' },
        { numero: '1', tipo: 'ECNA', descricao: 'ECNA Inconfidentes - Casais apoio' }
    ];

    const encontros = [];
    for (const definicao of definicoes) {
        const [[existente]] = await connection.query(
            `SELECT id, numero, tipo, descricao
             FROM tios_ecc
             WHERE tenant_id = ? AND numero = ? AND tipo = ?
             LIMIT 1`,
            [tenantId, definicao.numero, definicao.tipo]
        );

        if (existente) {
            if (!String(existente.descricao || '').trim() && definicao.descricao) {
                await connection.query(
                    'UPDATE tios_ecc SET descricao = ? WHERE id = ? AND tenant_id = ?',
                    [definicao.descricao, existente.id, tenantId]
                );
            }
            encontros.push({
                id: Number(existente.id),
                numero: String(existente.numero || definicao.numero),
                tipo: String(existente.tipo || definicao.tipo),
                descricao: String(existente.descricao || definicao.descricao || '')
            });
            continue;
        }

        const [result] = await connection.query(
            'INSERT INTO tios_ecc (tenant_id, numero, tipo, descricao) VALUES (?, ?, ?, ?)',
            [tenantId, definicao.numero, definicao.tipo, definicao.descricao]
        );
        encontros.push({
            id: Number(result.insertId),
            numero: definicao.numero,
            tipo: definicao.tipo,
            descricao: definicao.descricao
        });
    }

    return encontros;
}

async function main() {
    const connection = await pool.getConnection();
    let transactionOpen = false;
    try {
        const [[tenant]] = await connection.query(
            `SELECT id, nome_ejc
             FROM tenants_ejc
             WHERE UPPER(TRIM(nome_ejc)) = ?
             LIMIT 1`,
            [TENANT_NAME]
        );

        if (!tenant) {
            throw new Error(`Tenant "${TENANT_NAME}" não encontrado.`);
        }

        const tenantId = Number(tenant.id);

        const [[existingSeed]] = await connection.query(
            `SELECT COUNT(*) AS total
             FROM tios_casais
             WHERE tenant_id = ?
               AND observacoes LIKE ?`,
            [tenantId, `%${SEED_TAG}%`]
        );

        const jaInseridos = Number(existingSeed && existingSeed.total ? existingSeed.total : 0);
        const faltantes = TOTAL_CASAIS - jaInseridos;

        if (faltantes <= 0) {
            console.log(`Seed já aplicada. O tenant ${tenantId} já possui ${jaInseridos} casais fictícios com a tag ${SEED_TAG}.`);
            return;
        }

        const [[termosColuna]] = await connection.query(
            `SELECT COUNT(*) AS total
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'tios_casais'
               AND COLUMN_NAME = 'termos_aceitos_em'`
        );
        const hasTermosAceitos = Number(termosColuna && termosColuna.total ? termosColuna.total : 0) > 0;

        const encontros = await ensureEncontros(connection, tenantId);

        await connection.beginTransaction();
        transactionOpen = true;

        for (let i = 0; i < faltantes; i += 1) {
            const seq = jaInseridos + i + 1;
            const primeiroNomeTio = nomesTio[(seq - 1) % nomesTio.length];
            const primeiroNomeTia = nomesTia[(seq - 1) % nomesTia.length];
            const encontro = encontros[(seq - 1) % encontros.length] || null;
            const restricaoTio = seq % 5 === 0 ? 1 : 0;
            const restricaoTia = seq % 4 === 0 ? 1 : 0;
            const deficienciaTio = seq % 9 === 0 ? 1 : 0;
            const deficienciaTia = seq % 11 === 0 ? 1 : 0;

            const colunas = [
                'tenant_id',
                'ecc_id',
                'origem_tipo',
                'outro_ejc_id',
                'nome_tio',
                'telefone_tio',
                'data_nascimento_tio',
                'nome_tia',
                'telefone_tia',
                'data_nascimento_tia',
                'restricao_alimentar',
                'deficiencia',
                'restricao_alimentar_tio',
                'detalhes_restricao_tio',
                'deficiencia_tio',
                'qual_deficiencia_tio',
                'restricao_alimentar_tia',
                'detalhes_restricao_tia',
                'deficiencia_tia',
                'qual_deficiencia_tia',
                'observacoes'
            ];

            const valores = [
                tenantId,
                encontro ? encontro.id : null,
                'EJC',
                null,
                montarNomeCompleto(primeiroNomeTio, seq, 0),
                montarTelefone(seq, 970000000),
                montarData(seq, 1972),
                montarNomeCompleto(primeiroNomeTia, seq, 3),
                montarTelefone(seq, 980000000),
                montarData(seq, 1974),
                restricaoTio || restricaoTia ? 1 : 0,
                deficienciaTio || deficienciaTia ? 1 : 0,
                restricaoTio,
                restricaoTio ? 'Intolerante a lactose' : null,
                deficienciaTio,
                deficienciaTio ? 'Baixa visao' : null,
                restricaoTia,
                restricaoTia ? 'Vegetariana' : null,
                deficienciaTia,
                deficienciaTia ? 'Mobilidade reduzida' : null,
                `Casal fictício para teste da paginação e filtros (${SEED_TAG} #${seq}).`
            ];

            if (hasTermosAceitos) {
                colunas.push('termos_aceitos_em');
                valores.push(seq % 3 === 0 ? null : montarDataHoraAceite(seq));
            }

            const placeholders = colunas.map(() => '?').join(', ');
            await connection.query(
                `INSERT INTO tios_casais (${colunas.join(', ')}) VALUES (${placeholders})`,
                valores
            );
        }

        await connection.commit();
        transactionOpen = false;

        const [[summary]] = await connection.query(
            `SELECT
                (SELECT COUNT(*) FROM tios_casais WHERE tenant_id = ?) AS total_casais,
                (SELECT COUNT(*) FROM tios_casais WHERE tenant_id = ? AND observacoes LIKE ?) AS casais_seed,
                (SELECT COUNT(*) FROM tios_ecc WHERE tenant_id = ?) AS total_encontros`,
            [tenantId, tenantId, `%${SEED_TAG}%`, tenantId]
        );

        console.log(JSON.stringify({
            tenantId,
            tenantNome: tenant.nome_ejc,
            inseridosAgora: faltantes,
            totalCasais: Number(summary && summary.total_casais ? summary.total_casais : 0),
            totalCasaisSeed: Number(summary && summary.casais_seed ? summary.casais_seed : 0),
            totalEncontros: Number(summary && summary.total_encontros ? summary.total_encontros : 0)
        }, null, 2));
    } catch (error) {
        if (transactionOpen) {
            await connection.rollback();
        }
        throw error;
    } finally {
        connection.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error('Erro ao popular casais fictícios de tios para INCONFIDENTES:', error);
    process.exitCode = 1;
});
