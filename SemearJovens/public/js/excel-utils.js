/* eslint-disable no-undef */
(() => {
    function ensureXlsx() {
        if (typeof XLSX === 'undefined') {
            throw new Error('Biblioteca XLSX não carregada.');
        }
    }

    function exportJsonToXlsx({ filename, sheetName, rows }) {
        ensureXlsx();
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows || []);
        XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Dados');
        XLSX.writeFile(wb, filename || 'exportacao.xlsx');
    }

    function exportMultiSheet({ filename, sheets }) {
        ensureXlsx();
        const wb = XLSX.utils.book_new();
        (sheets || []).forEach((s) => {
            const ws = XLSX.utils.json_to_sheet(s.rows || []);
            XLSX.utils.book_append_sheet(wb, ws, s.name || 'Dados');
        });
        XLSX.writeFile(wb, filename || 'exportacao.xlsx');
    }

    async function readXlsxFile(file) {
        ensureXlsx();
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.SheetNames[0];
        if (!firstSheet) return [];
        const ws = workbook.Sheets[firstSheet];
        return XLSX.utils.sheet_to_json(ws, { defval: '' });
    }

    window.ExcelUtils = {
        exportJsonToXlsx,
        exportMultiSheet,
        readXlsxFile
    };
})();
