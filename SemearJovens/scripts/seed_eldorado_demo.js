const mysql = require('mysql2/promise');

const TENANT_ID = 12;

const connConfig = {
    host: '127.0.0.1',
    user: 'infra',
    password: 'M4n3r@@G1nx',
    database: 'db_semeajovens'
};

function createRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

const rand = createRng(12031994);

function pick(list) {
    return list[Math.floor(rand() * list.length)];
}

function randomInt(min, max) {
    return Math.floor(rand() * (max - min + 1)) + min;
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function randomDate(startYear, endYear) {
    const year = randomInt(startYear, endYear);
    const month = randomInt(1, 12);
    const day = randomInt(1, 28);
    return `${year}-${pad(month)}-${pad(day)}`;
}

function randomPhone(prefix) {
    return `31${prefix}${randomInt(1000000, 9999999)}`;
}

function uniqueFullNames(count, maleNames, femaleNames, surnames, sexes) {
    const used = new Set();
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        const sexo = sexes[i % sexes.length];
        const first = sexo === 'Masculino' ? pick(maleNames) : pick(femaleNames);
        let full = '';
        do {
            full = `${first} ${pick(surnames)} ${pick(surnames)}`;
        } while (used.has(full));
        used.add(full);
        rows.push({ nome: full, apelido: first, sexo });
    }
    return rows;
}

async function insertMany(connection, sql, values) {
    for (const value of values) {
        // eslint-disable-next-line no-await-in-loop
        await connection.query(sql, value);
    }
}

async function insertReturningId(connection, sql, values) {
    const [result] = await connection.query(sql, values);
    return result.insertId;
}

async function main() {
    const connection = await mysql.createConnection(connConfig);
    let stage = 'início';
    try {
        stage = 'buscar tenant';
        const [[tenant]] = await connection.query(
            'SELECT id, nome_ejc FROM tenants_ejc WHERE id = ? LIMIT 1',
            [TENANT_ID]
        );
        if (!tenant) {
            throw new Error(`Tenant ${TENANT_ID} não encontrado.`);
        }

        stage = 'verificar dados existentes';
        const [existing] = await connection.query(
            `SELECT
                (SELECT COUNT(*) FROM ejc WHERE tenant_id = ?) AS ejc_count,
                (SELECT COUNT(*) FROM equipes WHERE tenant_id = ?) AS equipes_count,
                (SELECT COUNT(*) FROM jovens WHERE tenant_id = ?) AS jovens_count,
                (SELECT COUNT(*) FROM tios_casais WHERE tenant_id = ?) AS tios_count,
                (SELECT COUNT(*) FROM outros_ejcs WHERE tenant_id = ?) AS outros_ejcs_count`,
            [TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID]
        );
        const counts = existing[0] || {};
        const totalExisting = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
        if (totalExisting > 0) {
            throw new Error('O tenant Eldorado já possui dados. A carga foi abortada para não sobrescrever nada.');
        }

        stage = 'abrir transação';
        await connection.beginTransaction();

        const equipes = [
            'Finanças',
            'Geral',
            'Sala',
            'Apoio e Acolhida',
            'Ordem e Limpeza',
            'Cafezinho',
            'Cozinha',
            'Secretaria',
            'Tios',
            'Liturgia Interna',
            'Liturgia Externa'
        ];

        const outrosEjcs = [
            ['São José Operário', 'EJC Raio de Luz', 'Novo Eldorado'],
            ['Nossa Senhora de Fátima', 'EJC Caminho Novo', 'Petrolândia'],
            ['São Pedro Apóstolo', 'EJC Chama Viva', 'Industrial'],
            ['Cristo Redentor', 'EJC Esperança', 'Riacho'],
            ['Imaculada Conceição', 'EJC Alegria', 'Água Branca'],
            ['Santana', 'EJC Semeadores', 'Jardim Laguna'],
            ['Nossa Senhora do Carmo', 'EJC Manancial', 'Eldorado'],
            ['Sagrado Coração', 'EJC Fonte de Vida', 'Glória'],
            ['São Francisco', 'EJC Luz do Mundo', 'Nacional'],
            ['Santa Luzia', 'EJC Viver em Cristo', 'Inconfidentes']
        ];

        const eccs = [
            { numero: '1', tipo: 'ECC', descricao: 'ECC de Casais 1' },
            { numero: '2', tipo: 'ECC', descricao: 'ECC de Casais 2' },
            { numero: '3', tipo: 'ECC', descricao: 'ECC de Casais 3' },
            { numero: '1', tipo: 'ECNA', descricao: 'ECNA 1' }
        ];

        const maleNames = ['João', 'Gabriel', 'Lucas', 'Mateus', 'Pedro', 'Gustavo', 'Rafael', 'Felipe', 'Thiago', 'Bruno', 'Daniel', 'Vitor', 'Caio', 'Henrique', 'Samuel', 'Leandro', 'André', 'Vinícius', 'Diego', 'Eduardo', 'César', 'Murilo', 'Yago', 'Leonardo', 'Arthur'];
        const femaleNames = ['Maria', 'Ana', 'Beatriz', 'Clara', 'Fernanda', 'Juliana', 'Larissa', 'Patrícia', 'Camila', 'Bianca', 'Vitória', 'Eduarda', 'Isabela', 'Luana', 'Sabrina', 'Aline', 'Paula', 'Michele', 'Nathalia', 'Lívia', 'Débora', 'Brenda', 'Karina', 'Jéssica', 'Priscila'];
        const surnames = ['Silva', 'Souza', 'Oliveira', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Ferreira', 'Gomes', 'Martins', 'Araújo', 'Ribeiro', 'Carvalho', 'Melo', 'Barbosa', 'Correia', 'Moreira', 'Teixeira', 'Rocha'];

        const tioNames = ['Carlos', 'Marcos', 'Ricardo', 'Fábio', 'Alexandre', 'Márcio', 'Roberto', 'Paulo', 'Fernando', 'Rodrigo', 'Sérgio', 'Luciano', 'Adriano', 'Cláudio', 'Renato', 'Gilberto', 'Valdir', 'Jorge', 'Maurício', 'Silvio'];
        const tiaNames = ['Márcia', 'Patrícia', 'Mônica', 'Silvana', 'Cristiane', 'Renata', 'Rosana', 'Eliane', 'Sandra', 'Luciana', 'Vanessa', 'Daniela', 'Tatiane', 'Carla', 'Adriana', 'Elaine', 'Fabiana', 'Simone', 'Verônica', 'Cíntia'];

        const ejcsToCreate = [
            {
                numero: 1,
                paroquia: 'Eldorado',
                ano: 2024,
                data_inicio: '2024-07-19',
                data_fim: '2024-07-21',
                data_encontro: '2024-07-19',
                data_tarde_revelacao: '2024-07-21',
                data_inicio_reunioes: '2024-05-15',
                data_fim_reunioes: '2024-07-10',
                descricao: '1º EJC fictício para testes do tenant Eldorado',
                musica_tema: 'Chamados para Servir'
            },
            {
                numero: 2,
                paroquia: 'Eldorado',
                ano: 2025,
                data_inicio: '2025-07-18',
                data_fim: '2025-07-20',
                data_encontro: '2025-07-18',
                data_tarde_revelacao: '2025-07-20',
                data_inicio_reunioes: '2025-05-14',
                data_fim_reunioes: '2025-07-09',
                descricao: '2º EJC fictício para testes do tenant Eldorado',
                musica_tema: 'Servir com Alegria'
            }
        ];

        stage = 'inserir ejcs';
        const ejcIds = [];
        for (const item of ejcsToCreate) {
            // eslint-disable-next-line no-await-in-loop
            const insertId = await insertReturningId(
                connection,
                `INSERT INTO ejc
                    (numero, paroquia, ano, data_inicio, data_fim, data_encontro, data_tarde_revelacao, data_inicio_reunioes, data_fim_reunioes, descricao, musica_tema, tenant_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    item.numero,
                    item.paroquia,
                    item.ano,
                    item.data_inicio,
                    item.data_fim,
                    item.data_encontro,
                    item.data_tarde_revelacao,
                    item.data_inicio_reunioes,
                    item.data_fim_reunioes,
                    item.descricao,
                    item.musica_tema,
                    TENANT_ID
                ]
            );
            ejcIds.push(insertId);
        }
        const ejcByNumero = new Map([[1, ejcIds[0]], [2, ejcIds[1]]]);
        const ejcLabelById = new Map([[ejcIds[0], '1º EJC'], [ejcIds[1], '2º EJC']]);

        stage = 'inserir equipes';
        const equipeIds = [];
        for (const nome of equipes) {
            // eslint-disable-next-line no-await-in-loop
            const insertId = await insertReturningId(
                connection,
                `INSERT INTO equipes
                    (nome, descricao, icone_classe, cor_icone, membros_outro_ejc, tenant_id, limite_homens, limite_mulheres)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    nome,
                    `Equipe fictícia ${nome} para testes do tenant Eldorado`,
                    'fas fa-users',
                    '#2563eb',
                    1,
                    TENANT_ID,
                    null,
                    null
                ]
            );
            equipeIds.push(insertId);
        }
        const equipeByNome = new Map(equipes.map((nome, idx) => [nome, equipeIds[idx]]));

        const equipesEjcRows = [];
        for (const ejcId of ejcIds) {
            for (const equipeId of equipeIds) {
                equipesEjcRows.push([ejcId, equipeId, TENANT_ID]);
            }
        }
        stage = 'vincular equipes_ejc';
        await insertMany(connection, 'INSERT INTO equipes_ejc (ejc_id, equipe_id, tenant_id) VALUES (?, ?, ?)', equipesEjcRows);

        stage = 'inserir outros ejcs';
        const outrosIds = [];
        for (let idx = 0; idx < outrosEjcs.length; idx += 1) {
            const item = outrosEjcs[idx];
            // eslint-disable-next-line no-await-in-loop
            const insertId = await insertReturningId(
                connection,
                'INSERT INTO outros_ejcs (paroquia, nome, bairro, observacoes, tenant_id) VALUES (?, ?, ?, ?, ?)',
                [item[0], item[1], item[2], `Outro EJC fictício ${idx + 1}`, TENANT_ID]
            );
            outrosIds.push(insertId);
        }

        stage = 'inserir encontros dos tios';
        const eccIds = [];
        for (const item of eccs) {
            // eslint-disable-next-line no-await-in-loop
            const insertId = await insertReturningId(
                connection,
                'INSERT INTO tios_ecc (tenant_id, numero, tipo, descricao) VALUES (?, ?, ?, ?)',
                [TENANT_ID, item.numero, item.tipo, item.descricao]
            );
            eccIds.push(insertId);
        }

        const localYoungs = uniqueFullNames(50, maleNames, femaleNames, surnames, ['Masculino', 'Feminino']);
        const otherYoungs = uniqueFullNames(20, maleNames, femaleNames, surnames, ['Feminino', 'Masculino']);
        const nonTiosTeams = equipes.filter((nome) => nome !== 'Tios');

        const youngInsertRows = [];
        for (let i = 0; i < localYoungs.length; i += 1) {
            const person = localYoungs[i];
            const fezNumero = i < 25 ? 1 : 2;
            youngInsertRows.push([
                person.nome,
                person.apelido,
                randomPhone('99'),
                `${person.nome.toLowerCase().replace(/\s+/g, '.').normalize('NFD').replace(/[\u0300-\u036f]/g, '')}@eldorado.teste`,
                randomDate(1993, 2007),
                ejcByNumero.get(fezNumero),
                'INCONFIDENTES',
                null,
                null,
                0,
                0,
                'Eldorado',
                `@${person.apelido.toLowerCase()}${i + 1}`,
                'Solteiro',
                null,
                i % 4 === 0 ? 'Azul' : (i % 4 === 1 ? 'Verde' : (i % 4 === 2 ? 'Vermelho' : 'Amarelo')),
                0,
                null,
                null,
                null,
                null,
                0,
                null,
                null,
                0,
                0,
                null,
                person.sexo,
                TENANT_ID,
                null,
                null,
                `Rua ${pick(['das Flores', 'dos Jasmins', 'São Judas', 'da Paz', 'do Carmo'])}`,
                String(randomInt(10, 999)),
                pick(['Eldorado', 'Novo Eldorado', 'Jardim Riacho', 'Petrolândia', 'Industrial']),
                'Contagem',
                `32310-${pad(randomInt(10, 99))}`
            ]);
        }
        for (let i = 0; i < otherYoungs.length; i += 1) {
            const person = otherYoungs[i];
            const outroIdx = i % outrosIds.length;
            youngInsertRows.push([
                person.nome,
                person.apelido,
                randomPhone('98'),
                `${person.nome.toLowerCase().replace(/\s+/g, '.').normalize('NFD').replace(/[\u0300-\u036f]/g, '')}@outroejc.teste`,
                randomDate(1992, 2006),
                null,
                'OUTRO_EJC',
                outrosIds[outroIdx],
                String(randomInt(1, 12)),
                1,
                0,
                outrosEjcs[outroIdx][0],
                `@${person.apelido.toLowerCase()}oe${i + 1}`,
                'Solteiro',
                null,
                i % 4 === 0 ? 'Azul' : (i % 4 === 1 ? 'Verde' : (i % 4 === 2 ? 'Vermelho' : 'Amarelo')),
                0,
                null,
                null,
                null,
                null,
                0,
                null,
                null,
                0,
                0,
                null,
                person.sexo,
                TENANT_ID,
                null,
                null,
                `Rua ${pick(['da Esperança', 'do Encontro', 'Santa Clara', 'São Bento', 'das Acácias'])}`,
                String(randomInt(10, 999)),
                outrosEjcs[outroIdx][2],
                'Contagem',
                `32320-${pad(randomInt(10, 99))}`
            ]);
        }

        stage = 'inserir jovens';
        const allYoungInsertedIds = [];
        for (const row of youngInsertRows) {
            // eslint-disable-next-line no-await-in-loop
            const insertId = await insertReturningId(
                connection,
                `INSERT INTO jovens
                    (nome_completo, apelido, telefone, email, data_nascimento, numero_ejc_fez, origem_ejc_tipo, outro_ejc_id, outro_ejc_numero,
                     transferencia_outro_ejc, ja_foi_moita_inconfidentes, paroquia, instagram, estado_civil, data_casamento, circulo, deficiencia,
                     qual_deficiencia, conjuge_id, conjuge_nome, conjuge_telefone, dirigente, observacoes_extras, foto_url, restricao_alimentar,
                     detalhes_restricao, instrumentos_musicais, sexo, tenant_id, conjuge_ecc_tipo, conjuge_ecc_numero,
                     endereco_rua, endereco_numero, endereco_bairro, endereco_cidade, endereco_cep)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                row
            );
            allYoungInsertedIds.push(insertId);
        }
        const localYoungIds = allYoungInsertedIds.slice(0, 50);
        const otherYoungIds = allYoungInsertedIds.slice(50);

        const historyRows = [];
        const allYoungIds = [...localYoungIds, ...otherYoungIds];
        for (let i = 0; i < allYoungIds.length; i += 1) {
            const jovemId = allYoungIds[i];
            const ejcId = i % 2 === 0 ? ejcIds[0] : ejcIds[1];
            const equipeNome = nonTiosTeams[i % nonTiosTeams.length];
            historyRows.push([
                jovemId,
                ejcLabelById.get(ejcId),
                equipeNome,
                'Membro',
                ejcId,
                null,
                TENANT_ID
            ]);
        }
        stage = 'inserir histórico de jovens';
        await insertMany(
            connection,
            `INSERT INTO historico_equipes
                (jovem_id, edicao_ejc, equipe, papel, ejc_id, subfuncao, tenant_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            historyRows
        );

        const localTios = [];
        const usedCouples = new Set();
        while (localTios.length < 30) {
            const tio = `${pick(tioNames)} ${pick(surnames)} ${pick(surnames)}`;
            const tia = `${pick(tiaNames)} ${pick(surnames)} ${pick(surnames)}`;
            const key = `${tio}|${tia}`;
            if (usedCouples.has(key)) continue;
            usedCouples.add(key);
            localTios.push({ nome_tio: tio, nome_tia: tia });
        }
        const otherTios = [];
        while (otherTios.length < 10) {
            const tio = `${pick(tioNames)} ${pick(surnames)} ${pick(surnames)}`;
            const tia = `${pick(tiaNames)} ${pick(surnames)} ${pick(surnames)}`;
            const key = `${tio}|${tia}`;
            if (usedCouples.has(key)) continue;
            usedCouples.add(key);
            otherTios.push({ nome_tio: tio, nome_tia: tia });
        }

        const tiosRows = [];
        for (let i = 0; i < localTios.length; i += 1) {
            const casal = localTios[i];
            const eccId = eccIds[i % eccIds.length];
            tiosRows.push([
                TENANT_ID,
                eccId,
                'EJC',
                null,
                casal.nome_tio,
                randomPhone('97'),
                randomDate(1968, 1987),
                casal.nome_tia,
                randomPhone('96'),
                randomDate(1969, 1989),
                0,
                0,
                0,
                null,
                0,
                null,
                0,
                null,
                0,
                null,
                'Casal fictício local para testes'
            ]);
        }
        for (let i = 0; i < otherTios.length; i += 1) {
            const casal = otherTios[i];
            const outroId = outrosIds[(i + 3) % outrosIds.length];
            tiosRows.push([
                TENANT_ID,
                null,
                'OUTRO_EJC',
                outroId,
                casal.nome_tio,
                randomPhone('95'),
                randomDate(1967, 1986),
                casal.nome_tia,
                randomPhone('94'),
                randomDate(1968, 1987),
                0,
                0,
                0,
                null,
                0,
                null,
                0,
                null,
                0,
                null,
                'Casal fictício de outro EJC para testes'
            ]);
        }

        stage = 'inserir tios';
        const tioIds = [];
        for (const row of tiosRows) {
            // eslint-disable-next-line no-await-in-loop
            const insertId = await insertReturningId(
                connection,
                `INSERT INTO tios_casais
                    (tenant_id, ecc_id, origem_tipo, outro_ejc_id, nome_tio, telefone_tio, data_nascimento_tio, nome_tia, telefone_tia, data_nascimento_tia,
                     restricao_alimentar, deficiencia, restricao_alimentar_tio, detalhes_restricao_tio, deficiencia_tio, qual_deficiencia_tio,
                     restricao_alimentar_tia, detalhes_restricao_tia, deficiencia_tia, qual_deficiencia_tia, observacoes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                row
            );
            tioIds.push(insertId);
        }

        const casalEquipeRows = [];
        const casalServicoRows = [];
        for (let i = 0; i < tioIds.length; i += 1) {
            const casalId = tioIds[i];
            const equipeId = equipeByNome.get('Tios');
            const ejcId = i % 2 === 0 ? ejcIds[0] : ejcIds[1];
            casalEquipeRows.push([TENANT_ID, casalId, equipeId]);
            casalServicoRows.push([TENANT_ID, casalId, equipeId, ejcId]);
        }
        stage = 'inserir tios_casal_equipes';
        await insertMany(connection, 'INSERT INTO tios_casal_equipes (tenant_id, casal_id, equipe_id) VALUES (?, ?, ?)', casalEquipeRows);
        stage = 'inserir tios_casal_servicos';
        await insertMany(connection, 'INSERT INTO tios_casal_servicos (tenant_id, casal_id, equipe_id, ejc_id) VALUES (?, ?, ?, ?)', casalServicoRows);

        stage = 'commit';
        await connection.commit();

        const [summary] = await connection.query(
            `SELECT
                (SELECT COUNT(*) FROM ejc WHERE tenant_id = ?) AS ejcs,
                (SELECT COUNT(*) FROM equipes WHERE tenant_id = ?) AS equipes,
                (SELECT COUNT(*) FROM jovens WHERE tenant_id = ? AND origem_ejc_tipo = 'INCONFIDENTES') AS jovens_locais,
                (SELECT COUNT(*) FROM jovens WHERE tenant_id = ? AND origem_ejc_tipo = 'OUTRO_EJC') AS jovens_outro_ejc,
                (SELECT COUNT(*) FROM tios_casais WHERE tenant_id = ? AND origem_tipo = 'EJC') AS tios_locais,
                (SELECT COUNT(*) FROM tios_casais WHERE tenant_id = ? AND origem_tipo = 'OUTRO_EJC') AS tios_outro_ejc,
                (SELECT COUNT(*) FROM outros_ejcs WHERE tenant_id = ?) AS outros_ejcs,
                (SELECT COUNT(*) FROM tios_ecc WHERE tenant_id = ?) AS encontros_tios,
                (SELECT COUNT(*) FROM historico_equipes WHERE tenant_id = ?) AS historicos_jovens,
                (SELECT COUNT(*) FROM tios_casal_servicos WHERE tenant_id = ?) AS historicos_tios`,
            [TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID]
        );

        console.log(JSON.stringify({
            tenant: tenant.nome_ejc,
            tenant_id: TENANT_ID,
            ...summary[0]
        }, null, 2));
    } catch (err) {
        try {
            await connection.rollback();
        } catch (_) {}
        console.error(`Falha na etapa: ${stage}`);
        console.error(err.message || err);
        process.exitCode = 1;
    } finally {
        await connection.end();
    }
}

main();
