-- Migration 000032: Módulo de Documentos (Diretrizes Nacionais EJC)
-- Criado em: 2026-06-28
-- Descrição: Cria as tabelas necessárias para o menu Documentos

-- Tabela principal de documentos
CREATE TABLE IF NOT EXISTS `documentos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `titulo` varchar(255) NOT NULL,
  `descricao` text,
  `ativo` tinyint(1) DEFAULT '1',
  `ordem` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `is_nacional` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `idx_documentos_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Capítulos do documento
CREATE TABLE IF NOT EXISTS `documento_capitulos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `documento_id` int NOT NULL,
  `numero` int NOT NULL,
  `titulo` varchar(255) NOT NULL,
  `descricao` text,
  `ordem` int DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_doc_cap_documento` (`documento_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Seções dentro de cada capítulo
CREATE TABLE IF NOT EXISTS `documento_secoes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `capitulo_id` int NOT NULL,
  `titulo` varchar(255) NOT NULL,
  `descricao` text,
  `ordem` int DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_doc_sec_capitulo` (`capitulo_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Tópicos dentro de cada seção
CREATE TABLE IF NOT EXISTS `documento_topicos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `secao_id` int NOT NULL,
  `titulo` varchar(255) NOT NULL,
  `conteudo` longtext,
  `ordem` int DEFAULT '0',
  `pagina_ref` int DEFAULT NULL,
  `tem_subtopicos` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_doc_top_secao` (`secao_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Subtópicos dentro de cada tópico
CREATE TABLE IF NOT EXISTS `documento_subtopicos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `topico_id` int NOT NULL,
  `titulo` varchar(255) NOT NULL,
  `conteudo` longtext,
  `ordem` int DEFAULT '0',
  `pagina_ref` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_doc_sub_topico` (`topico_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Progresso de leitura por usuário
CREATE TABLE IF NOT EXISTS `documento_progresso` (
  `id` int NOT NULL AUTO_INCREMENT,
  `usuario_id` int NOT NULL,
  `tenant_id` int NOT NULL,
  `topico_id` int DEFAULT NULL,
  `subtopico_id` int DEFAULT NULL,
  `status` enum('nao_lido','lendo','lido') DEFAULT 'nao_lido',
  `lido_em` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_doc_prog_usuario_tenant` (`usuario_id`,`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Destaques (marca-texto) por usuário
CREATE TABLE IF NOT EXISTS `documento_destaques` (
  `id` int NOT NULL AUTO_INCREMENT,
  `usuario_id` int NOT NULL,
  `tenant_id` int NOT NULL,
  `topico_id` int DEFAULT NULL,
  `subtopico_id` int DEFAULT NULL,
  `texto_destacado` text NOT NULL,
  `nota` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_doc_dest_usuario_tenant` (`usuario_id`,`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Favoritos por usuário
CREATE TABLE IF NOT EXISTS `documento_favoritos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `usuario_id` int NOT NULL,
  `tenant_id` int NOT NULL,
  `tipo` enum('capitulo','secao','topico','subtopico') NOT NULL,
  `ref_id` int NOT NULL,
  `titulo` varchar(500) NOT NULL,
  `contexto` varchar(500) DEFAULT NULL,
  `capitulo_id` int DEFAULT NULL,
  `secao_id` int DEFAULT NULL,
  `topico_id` int DEFAULT NULL,
  `subtopico_id` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_doc_fav_usuario_tenant` (`usuario_id`,`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
