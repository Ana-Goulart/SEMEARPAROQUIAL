const { pool } = require('../database');

const TENANT_NAME = 'INCONFIDENTES';
const TOTAL_REGISTROS = 20;
const SEED_TAG = 'seed_lista_mestre_inconfidentes_paginacao_v1';

const nomesMasculinos = [
    'Gabriel', 'Lucas', 'Mateus', 'Pedro', 'Joao', 'Rafael', 'Thiago', 'Bruno', 'Daniel', 'Vinicius',
    'Samuel', 'Henrique', 'Caio', 'Arthur', 'Eduardo', 'Leandro', 'André', 'Murilo', 'Gustavo', 'Felipe'
];

const nomesFemininos = [
    'Ana', 'Clara', 'Beatriz', 'Fernanda', 'Juliana', 'Larissa', 'Camila', 'Bianca', 'Patricia', 'Livia',
    'Nathalia', 'Isabela', 'Sabrina', 'Aline', 'Paula', 'Michele', 'Debora', 'Karina', 'Jessica', 'Brenda'
];

const sobrenomes = [
    'Silva', 'Souza', 'Oliveira', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Ferreira', 'Gomes',
    'Martins', 'Araujo', 'Ribeiro', 'Carvalho', 'Melo', 'Barbosa', 'Moreira', 'Teixeira', 'Rocha', 'Correia'
];

const ruas = [
    'Rua das Flores', 'Rua da Esperanca', 'Rua Sao Jose', 'Rua da Matriz', 'Rua do Rosario',
    'Rua Padre Eustaquio', 'Rua Domingos Savio', 'Rua das Oliveiras', 'Rua Sao Bento', 'Rua Santa Clara'
];

const bairros = [
    'Centro', 'Inconfidentes', 'Novo Eldorado', 'Jardim Riacho', 'Petrolandia',
    'Novo Progresso', 'Industrial', 'Santa Helena', 'Europa', 'Amazonas'
];

function pad(value) {
    return String(value).padStart(2, '0');
}

function montarDataNascimento(seq) {
    const ano = 1992 + (seq % 11);
    const mes = (seq % 12) + 1;
    const dia = ((seq * 3) % 27) + 1;
    return `${ano}-${pad(mes)}-${pad(dia)}`;
}

function montarDataCasamento(seq) {
    const ano = 2018 + (seq % 6);
    const mes = ((seq + 4) % 12) + 1;
    const dia = ((seq * 2) % 27) + 1;
    return `${ano}-${pad(mes)}-${pad(dia)}`;
}

function montarTelefone(seq) {
    const numero = String(970000000 + seq).slice(-9);
    return `(31)${numero.slice(0, 5)}-${numero.slice(5)}`;
}

function montarCep(seq) {
    const numero = String(32000000 + seq).slice(-8);
    return `${numero.slice(0, 5)}-${numero.slice(5)}`;
}

function montarNome(seq, sexo) {
    const primeiroNome = sexo === 'Masculino'
        ? nomesMasculinos[(seq - 1) % nomesMasculinos.length]
        : nomesFemininos[(seq - 1) % nomesFemininos.length];
    const sobrenomeA = sobrenomes[(seq - 1) % sobrenomes.length];
    const sobrenomeB = sobrenomes[(seq + 6) % sobrenomes.length];
    return {
        nomeCompleto: `${primeiroNome} ${sobrenomeA} ${sobrenomeB}`,
        apelido: primeiroNome
    };
}

async function main() {
    const connection = await pool.getConnection();
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
             FROM jovens
             WHERE tenant_id = ?
               AND observacoes_extras LIKE ?`,
            [tenantId, `%${SEED_TAG}%`]
        );

        const jaInseridos = Number(existingSeed && existingSeed.total ? existingSeed.total : 0);
        const faltantes = TOTAL_REGISTROS - jaInseridos;

        if (faltantes <= 0) {
            console.log(`Seed já aplicada. O tenant ${tenantId} já possui ${jaInseridos} registros fictícios com a tag ${SEED_TAG}.`);
            return;
        }

        const [ejcsRows] = await connection.query(
            'SELECT id, numero FROM ejc WHERE tenant_id = ? ORDER BY numero ASC',
            [tenantId]
        );
        const ejcIds = (ejcsRows || []).map((row) => Number(row.id)).filter((value) => Number.isFinite(value) && value > 0);

        let circulos = [];
        try {
            const [circulosRows] = await connection.query(
                'SELECT nome FROM circulos WHERE tenant_id = ? AND ativo = 1 ORDER BY nome ASC',
                [tenantId]
            );
            circulos = (circulosRows || []).map((row) => String(row.nome || '').trim()).filter(Boolean);
        } catch (_) {
            circulos = [];
        }

        await connection.beginTransaction();

        for (let i = 0; i < faltantes; i += 1) {
            const seq = jaInseridos + i + 1;
            const sexo = seq % 2 === 0 ? 'Masculino' : 'Feminino';
            const { nomeCompleto, apelido } = montarNome(seq, sexo);
            const telefone = montarTelefone(seq);
            const email = `teste.listamestre.inconfidentes.${seq}@semear.local`;
            const instagram = `teste_inconfidentes_${seq}`;
            const estadoCivil = seq % 9 === 0 ? 'Casado' : (seq % 5 === 0 ? 'Amasiado' : 'Solteiro');
            const dataCasamento = estadoCivil === 'Solteiro' ? null : montarDataCasamento(seq);
            const deficiencia = seq % 11 === 0 ? 1 : 0;
            const restricaoAlimentar = seq % 6 === 0 ? 1 : 0;
            const ehMusico = seq % 4 === 0 ? 1 : 0;
            const equipeSaude = seq % 8 === 0 ? 1 : 0;
            const naoServeEjc = seq % 6 === 0 ? 1 : 0;
            const numeroEjcId = ejcIds.length ? ejcIds[(seq - 1) % ejcIds.length] : null;
            const circulo = circulos.length && seq % 3 === 0 ? circulos[(seq - 1) % circulos.length] : null;
            const instrumentos = ehMusico ? JSON.stringify([seq % 2 === 0 ? 'Violao' : 'Teclado']) : null;
            const observacoesExtras = `Registro fictício para testes de paginação (${SEED_TAG}) #${seq}`;

            await connection.query(
                `INSERT INTO jovens (
                    tenant_id,
                    nome_completo,
                    apelido,
                    telefone,
                    email,
                    termos_aceitos_em,
                    termos_aceitos_email,
                    data_nascimento,
                    numero_ejc_fez,
                    lista_mestre_ativo,
                    origem_ejc_tipo,
                    instagram,
                    estado_civil,
                    data_casamento,
                    circulo,
                    deficiencia,
                    qual_deficiencia,
                    nao_serve_ejc,
                    motivo_nao_serve_ejc,
                    restricao_alimentar,
                    detalhes_restricao,
                    eh_musico,
                    equipe_saude,
                    instrumentos_musicais,
                    sexo,
                    endereco_rua,
                    endereco_numero,
                    endereco_bairro,
                    endereco_cidade,
                    endereco_cep,
                    observacoes_extras
                ) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, 1, 'INCONFIDENTES', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    nomeCompleto,
                    apelido,
                    telefone,
                    email,
                    email,
                    montarDataNascimento(seq),
                    numeroEjcId,
                    instagram,
                    estadoCivil,
                    dataCasamento,
                    circulo,
                    deficiencia,
                    deficiencia ? 'Baixa visão' : null,
                    naoServeEjc,
                    naoServeEjc ? 'Registro fictício marcado como inativo para testes.' : null,
                    restricaoAlimentar,
                    restricaoAlimentar ? 'Intolerância à lactose' : null,
                    ehMusico,
                    equipeSaude,
                    instrumentos,
                    sexo,
                    ruas[(seq - 1) % ruas.length],
                    String((seq % 180) + 10),
                    bairros[(seq - 1) % bairros.length],
                    'Contagem',
                    montarCep(seq),
                    observacoesExtras
                ]
            );
        }

        await connection.commit();

        const [[totais]] = await connection.query(
            `SELECT COUNT(*) AS total, SUM(CASE WHEN nao_serve_ejc = 1 THEN 1 ELSE 0 END) AS nao_servem
             FROM jovens
             WHERE tenant_id = ?`,
            [tenantId]
        );

        console.log(`Inseridos ${faltantes} registros fictícios no tenant ${tenantId} (${tenant.nome_ejc}).`);
        console.log(`Total atual no tenant: ${Number(totais.total || 0)} jovens, sendo ${Number(totais.nao_servem || 0)} marcados como não servem.`);
    } catch (error) {
        await connection.rollback().catch(() => {});
        console.error('Erro ao popular dados fictícios da Lista Mestre do Inconfidentes:', error.message || error);
        process.exitCode = 1;
    } finally {
        connection.release();
        await pool.end();
    }
}

main();
