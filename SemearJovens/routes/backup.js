const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { pool } = require('../database');

const router = express.Router();

const upload = multer({ dest: path.join(__dirname, '..', 'tmp') });

function getDbConfig() {
    const cfg = pool && pool.pool && pool.pool.config && pool.pool.config.connectionConfig
        ? pool.pool.config.connectionConfig
        : (pool && pool.config && pool.config.connectionConfig ? pool.config.connectionConfig : {});
    return {
        host: cfg.host || 'localhost',
        user: cfg.user || 'root',
        password: cfg.password || '',
        database: cfg.database || '',
        port: cfg.port || 3306
    };
}

router.get('/database', async (_req, res) => {
    return res.status(403).json({ error: 'Backup completo do banco foi bloqueado neste módulo por segurança de tenant.' });
    /*
    try {
        const { host, user, password, database, port } = getDbConfig();
        if (!database) {
            return res.status(500).json({ error: 'Banco de dados não configurado.' });
        }

        const now = new Date();
        const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        const filename = `backup_${database}_${stamp}.sql`;

        res.setHeader('Content-Type', 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        const args = [
            '--single-transaction',
            '--skip-lock-tables',
            '--routines',
            '--triggers',
            '--events',
            `--host=${host}`,
            `--port=${port}`,
            `--user=${user}`
        ];

        if (password) {
            args.push(`--password=${password}`);
        }
        args.push(database);

        const dump = spawn('mysqldump', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        dump.stdout.pipe(res);
        let errData = '';
        dump.stderr.on('data', (chunk) => {
            errData += chunk.toString();
        });

        dump.on('error', (err) => {
            console.error('Erro ao executar mysqldump:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Falha ao gerar backup. Verifique se o mysqldump está instalado.' });
            } else {
                res.end();
            }
        });

        dump.on('close', (code) => {
            if (code !== 0) {
                console.error('mysqldump falhou:', errData || `codigo ${code}`);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Falha ao gerar backup do banco.' });
                } else {
                    res.end();
                }
            }
        });
    } catch (err) {
        console.error('Erro ao gerar backup:', err);
        return res.status(500).json({ error: 'Erro ao gerar backup.' });
    }
    */
});

router.post('/database/import', upload.single('arquivo'), async (req, res) => {
    return res.status(403).json({ error: 'Importação completa do banco foi bloqueada neste módulo por segurança de tenant.' });
    /*
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    try {
        const { host, user, password, database, port } = getDbConfig();
        if (!database) {
            return res.status(500).json({ error: 'Banco de dados não configurado.' });
        }

        const args = [
            `--host=${host}`,
            `--port=${port}`,
            `--user=${user}`
        ];
        if (password) args.push(`--password=${password}`);
        args.push(database);

        const mysql = spawn('mysql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const readStream = fs.createReadStream(file.path);
        readStream.pipe(mysql.stdin);

        let errData = '';
        mysql.stderr.on('data', (chunk) => {
            errData += chunk.toString();
        });

        mysql.on('error', (err) => {
            console.error('Erro ao executar mysql:', err);
        });

        mysql.on('close', (code) => {
            try { fs.unlinkSync(file.path); } catch (_) { }
            if (code !== 0) {
                console.error('mysql import falhou:', errData || `codigo ${code}`);
                return res.status(500).json({ error: 'Falha ao importar backup. Verifique se o mysql está instalado.' });
            }
            return res.json({ message: 'Backup importado com sucesso.' });
        });
    } catch (err) {
        try { if (file && file.path) fs.unlinkSync(file.path); } catch (_) { }
        console.error('Erro ao importar backup:', err);
        return res.status(500).json({ error: 'Erro ao importar backup.' });
    }
    */
});

module.exports = router;
