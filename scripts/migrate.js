#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const args = {
        database: 'semear_paroquial',
        env: 'SemearLogin/.env',
        dryRun: false,
        list: false
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--list') {
            args.list = true;
        } else if (arg === '--database') {
            args.database = argv[i + 1];
            i += 1;
        } else if (arg.startsWith('--database=')) {
            args.database = arg.slice('--database='.length);
        } else if (arg === '--env') {
            args.env = argv[i + 1];
            i += 1;
        } else if (arg.startsWith('--env=')) {
            args.env = arg.slice('--env='.length);
        } else {
            throw new Error(`Argumento desconhecido: ${arg}`);
        }
    }

    if (!args.database) throw new Error('Informe --database.');
    if (!args.env) throw new Error('Informe --env.');
    return args;
}

function parseEnvFile(filePath) {
    const env = {};
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const index = line.indexOf('=');
        if (index === -1) continue;
        const key = line.slice(0, index).trim();
        let value = line.slice(index + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }
    return env;
}

function requireMysql() {
    const candidates = [
        'mysql2/promise',
        path.join(process.cwd(), 'SemearLogin/node_modules/mysql2/promise'),
        path.join(process.cwd(), 'SemearJovens/node_modules/mysql2/promise'),
        path.join(process.cwd(), 'SemearCore/node_modules/mysql2/promise'),
        path.join(process.cwd(), 'SemearAdmin/node_modules/mysql2/promise'),
        path.join(process.cwd(), 'SemearCatequese/node_modules/mysql2/promise')
    ];

    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (_) {
            // Try the next installed module location.
        }
    }

    throw new Error('Nao encontrei mysql2. Rode npm install em algum modulo ou instale mysql2 na raiz.');
}

function checksum(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function getMigrationFiles(migrationsDir) {
    if (!fs.existsSync(migrationsDir)) {
        throw new Error(`Pasta de migrations nao encontrada: ${migrationsDir}`);
    }

    return fs.readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b))
        .map((file) => {
            const fullPath = path.join(migrationsDir, file);
            const sql = fs.readFileSync(fullPath, 'utf8');
            return {
                filename: file,
                fullPath,
                sql,
                checksum: checksum(sql)
            };
        });
}

async function ensureMigrationsTable(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            filename VARCHAR(255) NOT NULL UNIQUE,
            checksum CHAR(64) NOT NULL,
            executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function getAppliedMigrations(connection) {
    const [rows] = await connection.query('SELECT filename, checksum, executed_at FROM schema_migrations ORDER BY filename');
    return new Map(rows.map((row) => [row.filename, row]));
}

function printPlan(files, applied) {
    if (!files.length) {
        console.log('Nenhuma migration encontrada.');
        return;
    }

    for (const file of files) {
        const current = applied.get(file.filename);
        if (!current) {
            console.log(`PENDENTE  ${file.filename}`);
        } else if (current.checksum !== file.checksum) {
            console.log(`ALTERADA  ${file.filename}`);
        } else {
            console.log(`OK        ${file.filename}`);
        }
    }
}

async function main() {
    const args = parseArgs(process.argv);
    const rootDir = process.cwd();
    const envPath = path.resolve(rootDir, args.env);
    const migrationsDir = path.resolve(rootDir, 'migrations', args.database);
    const env = parseEnvFile(envPath);
    const mysql = requireMysql();

    const dbName = env.DB_NAME;
    if (!dbName) throw new Error(`DB_NAME nao encontrado em ${args.env}.`);

    const connection = await mysql.createConnection({
        host: env.DB_HOST || '127.0.0.1',
        port: Number(env.DB_PORT || 3306),
        user: env.DB_USER,
        password: env.DB_PASS || env.DB_PASSWORD || '',
        database: dbName,
        multipleStatements: true
    });

    try {
        await ensureMigrationsTable(connection);
        const files = getMigrationFiles(migrationsDir);
        const applied = await getAppliedMigrations(connection);

        console.log(`Banco: ${dbName}`);
        console.log(`Env: ${path.relative(rootDir, envPath)}`);
        console.log(`Migrations: ${path.relative(rootDir, migrationsDir)}`);

        if (args.dryRun || args.list) {
            printPlan(files, applied);
            return;
        }

        let executed = 0;
        for (const file of files) {
            const current = applied.get(file.filename);
            if (current && current.checksum !== file.checksum) {
                throw new Error(`A migration ${file.filename} ja foi executada, mas o arquivo mudou. Crie uma nova migration em vez de editar uma antiga.`);
            }
            if (current) continue;

            console.log(`Executando ${file.filename}...`);
            await connection.query(file.sql);
            await connection.query(
                'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
                [file.filename, file.checksum]
            );
            executed += 1;
        }

        if (!executed) {
            console.log('Tudo certo. Nenhuma migration pendente.');
        } else {
            console.log(`Concluido. Migrations executadas: ${executed}.`);
        }
    } finally {
        await connection.end();
    }
}

main().catch((err) => {
    console.error(`Erro ao executar migrations: ${err.message}`);
    process.exitCode = 1;
});
