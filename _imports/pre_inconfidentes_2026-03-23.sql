-- MySQL dump 10.13  Distrib 8.0.45, for Linux (x86_64)
--
-- Host: localhost    Database: db_semeajovens
-- ------------------------------------------------------
-- Server version	8.0.45-0ubuntu0.24.04.1

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `tenants_ejc`
--

DROP TABLE IF EXISTS `tenants_ejc`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tenants_ejc` (
  `id` int NOT NULL AUTO_INCREMENT,
  `nome_ejc` varchar(160) NOT NULL,
  `paroquia` varchar(180) NOT NULL,
  `endereco` varchar(255) DEFAULT NULL,
  `cidade` varchar(120) NOT NULL,
  `estado` varchar(120) NOT NULL,
  `modules_json` longtext,
  `estado_atende` varchar(120) DEFAULT NULL,
  `cidade_atende` varchar(120) DEFAULT NULL,
  `bairros_atendidos` longtext,
  `ativo` tinyint(1) NOT NULL DEFAULT '1',
  `motivo_desabilitacao` text,
  `desabilitado_em` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenant_nome_local` (`nome_ejc`,`cidade`,`estado`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tenants_ejc`
--

LOCK TABLES `tenants_ejc` WRITE;
/*!40000 ALTER TABLE `tenants_ejc` DISABLE KEYS */;
INSERT INTO `tenants_ejc` VALUES (1,'TESTE','TESTE',NULL,'Belo Horizonte','MG','[]',NULL,NULL,NULL,1,NULL,NULL,'2026-03-08 20:50:43','2026-03-08 20:51:44'),(9,'Inconfidentes','Paroquia Nossa Senhora do Sagrado coração','Rua teste','Contagem','MG','[\"semear-jovens\"]',NULL,NULL,NULL,1,NULL,NULL,'2026-03-23 18:26:50','2026-03-23 18:27:25');
/*!40000 ALTER TABLE `tenants_ejc` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `ejc`
--

DROP TABLE IF EXISTS `ejc`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ejc` (
  `id` int NOT NULL AUTO_INCREMENT,
  `numero` int NOT NULL,
  `paroquia` varchar(100) NOT NULL,
  `ano` int DEFAULT NULL,
  `data_inicio` date DEFAULT NULL,
  `data_fim` date DEFAULT NULL,
  `data_encontro` date DEFAULT NULL,
  `data_tarde_revelacao` date DEFAULT NULL,
  `data_inicio_reunioes` date DEFAULT NULL,
  `data_fim_reunioes` date DEFAULT NULL,
  `descricao` text,
  `musica_tema` varchar(180) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `tenant_id` int NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `numero` (`numero`),
  KEY `idx_ejc_tenant` (`tenant_id`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `ejc`
--

LOCK TABLES `ejc` WRITE;
/*!40000 ALTER TABLE `ejc` DISABLE KEYS */;
/*!40000 ALTER TABLE `ejc` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `equipes`
--

DROP TABLE IF EXISTS `equipes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `equipes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `nome` varchar(100) NOT NULL,
  `descricao` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `icone_classe` varchar(120) DEFAULT NULL,
  `cor_icone` varchar(20) DEFAULT '#2563eb',
  `membros_outro_ejc` tinyint(1) NOT NULL DEFAULT '0',
  `tenant_id` int NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `nome` (`nome`),
  KEY `idx_equipes_tenant` (`tenant_id`)
) ENGINE=InnoDB AUTO_INCREMENT=14 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `equipes`
--

LOCK TABLES `equipes` WRITE;
/*!40000 ALTER TABLE `equipes` DISABLE KEYS */;
/*!40000 ALTER TABLE `equipes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `equipes_ejc`
--

DROP TABLE IF EXISTS `equipes_ejc`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `equipes_ejc` (
  `id` int NOT NULL AUTO_INCREMENT,
  `ejc_id` int NOT NULL,
  `equipe_id` int NOT NULL,
  `tenant_id` int NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_ejc_equipe` (`ejc_id`,`equipe_id`),
  KEY `equipe_id` (`equipe_id`),
  KEY `idx_equipes_ejc_tenant` (`tenant_id`),
  CONSTRAINT `equipes_ejc_ibfk_1` FOREIGN KEY (`ejc_id`) REFERENCES `ejc` (`id`) ON DELETE CASCADE,
  CONSTRAINT `equipes_ejc_ibfk_2` FOREIGN KEY (`equipe_id`) REFERENCES `equipes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=68 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `equipes_ejc`
--

LOCK TABLES `equipes_ejc` WRITE;
/*!40000 ALTER TABLE `equipes_ejc` DISABLE KEYS */;
/*!40000 ALTER TABLE `equipes_ejc` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `circulos`
--

DROP TABLE IF EXISTS `circulos`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `circulos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `nome` varchar(80) NOT NULL,
  `cor_hex` varchar(7) DEFAULT NULL,
  `ordem` int NOT NULL DEFAULT '0',
  `ativo` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `tenant_id` int NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_circulos_nome_tenant` (`tenant_id`,`nome`),
  KEY `idx_circulos_tenant` (`tenant_id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `circulos`
--

LOCK TABLES `circulos` WRITE;
/*!40000 ALTER TABLE `circulos` DISABLE KEYS */;
INSERT INTO `circulos` VALUES (8,'Azul','#ADD8E6',0,1,'2026-03-23 18:29:11','2026-03-23 18:29:11',9),(9,'Rosa','#FFC0CB',0,1,'2026-03-23 18:29:32','2026-03-23 18:29:32',9);
/*!40000 ALTER TABLE `circulos` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `outros_ejcs`
--

DROP TABLE IF EXISTS `outros_ejcs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `outros_ejcs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `paroquia` varchar(255) NOT NULL,
  `nome` varchar(255) DEFAULT NULL,
  `bairro` varchar(255) NOT NULL,
  `observacoes` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `tenant_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_outros_ejcs_tenant` (`tenant_id`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `outros_ejcs`
--

LOCK TABLES `outros_ejcs` WRITE;
/*!40000 ALTER TABLE `outros_ejcs` DISABLE KEYS */;
/*!40000 ALTER TABLE `outros_ejcs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `jovens`
--

DROP TABLE IF EXISTS `jovens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `jovens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `nome_completo` varchar(150) NOT NULL,
  `apelido` varchar(120) DEFAULT NULL,
  `telefone` varchar(20) DEFAULT NULL,
  `email` varchar(180) DEFAULT NULL,
  `termos_aceitos_em` datetime DEFAULT NULL,
  `termos_aceitos_email` varchar(180) DEFAULT NULL,
  `data_nascimento` date DEFAULT NULL,
  `numero_ejc_fez` int DEFAULT NULL,
  `montagem_ejc_id` int DEFAULT NULL,
  `lista_mestre_ativo` tinyint(1) NOT NULL DEFAULT '1',
  `origem_ejc_tipo` enum('INCONFIDENTES','OUTRO_EJC') NOT NULL DEFAULT 'INCONFIDENTES',
  `outro_ejc_id` int DEFAULT NULL,
  `outro_ejc_numero` varchar(30) DEFAULT NULL,
  `transferencia_outro_ejc` tinyint(1) NOT NULL DEFAULT '0',
  `ja_foi_moita_inconfidentes` tinyint(1) NOT NULL DEFAULT '0',
  `moita_ejc_id` int DEFAULT NULL,
  `moita_funcao` varchar(120) DEFAULT NULL,
  `paroquia` varchar(100) DEFAULT NULL,
  `instagram` varchar(100) DEFAULT NULL,
  `estado_civil` varchar(20) DEFAULT NULL,
  `data_casamento` date DEFAULT NULL,
  `circulo` varchar(50) DEFAULT NULL,
  `deficiencia` tinyint(1) DEFAULT '0',
  `qual_deficiencia` varchar(150) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `conjuge_id` int DEFAULT NULL,
  `conjuge_nome` varchar(150) DEFAULT NULL,
  `conjuge_telefone` varchar(30) DEFAULT NULL,
  `conjuge_ejc_id` int DEFAULT NULL,
  `dirigente` tinyint(1) DEFAULT '0',
  `observacoes_extras` text,
  `nao_serve_ejc` tinyint(1) NOT NULL DEFAULT '0',
  `motivo_nao_serve_ejc` text,
  `foto_url` varchar(255) DEFAULT NULL,
  `restricao_alimentar` tinyint(1) DEFAULT '0',
  `detalhes_restricao` varchar(255) DEFAULT NULL,
  `conjuge_outro_ejc_id` int DEFAULT NULL,
  `eh_musico` tinyint(1) DEFAULT '0',
  `equipe_saude` tinyint(1) NOT NULL DEFAULT '0',
  `instrumentos_musicais` text,
  `sexo` enum('Feminino','Masculino') DEFAULT NULL,
  `tenant_id` int NOT NULL,
  `conjuge_ecc_tipo` varchar(10) DEFAULT NULL,
  `conjuge_ecc_numero` varchar(30) DEFAULT NULL,
  `endereco_rua` varchar(180) DEFAULT NULL,
  `endereco_numero` varchar(30) DEFAULT NULL,
  `endereco_bairro` varchar(120) DEFAULT NULL,
  `endereco_cidade` varchar(120) DEFAULT NULL,
  `endereco_cep` varchar(12) DEFAULT NULL,
  `conjuge_paroquia` varchar(180) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `numero_ejc_fez` (`numero_ejc_fez`),
  KEY `conjuge_id` (`conjuge_id`),
  KEY `conjuge_ejc_id` (`conjuge_ejc_id`),
  KEY `idx_jovens_tenant` (`tenant_id`),
  CONSTRAINT `jovens_ibfk_1` FOREIGN KEY (`numero_ejc_fez`) REFERENCES `ejc` (`id`),
  CONSTRAINT `jovens_ibfk_2` FOREIGN KEY (`conjuge_id`) REFERENCES `jovens` (`id`) ON DELETE SET NULL,
  CONSTRAINT `jovens_ibfk_3` FOREIGN KEY (`conjuge_ejc_id`) REFERENCES `ejc` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=37 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `jovens`
--

LOCK TABLES `jovens` WRITE;
/*!40000 ALTER TABLE `jovens` DISABLE KEYS */;
/*!40000 ALTER TABLE `jovens` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `historico_equipes`
--

DROP TABLE IF EXISTS `historico_equipes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `historico_equipes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `jovem_id` int NOT NULL,
  `edicao_ejc` varchar(50) DEFAULT NULL,
  `equipe` varchar(100) DEFAULT NULL,
  `papel` varchar(50) DEFAULT 'Membro',
  `ejc_id` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `subfuncao` varchar(120) DEFAULT NULL,
  `tenant_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `jovem_id` (`jovem_id`),
  KEY `ejc_id` (`ejc_id`),
  KEY `idx_historico_equipes_tenant` (`tenant_id`),
  CONSTRAINT `historico_equipes_ibfk_1` FOREIGN KEY (`jovem_id`) REFERENCES `jovens` (`id`) ON DELETE CASCADE,
  CONSTRAINT `historico_equipes_ibfk_2` FOREIGN KEY (`ejc_id`) REFERENCES `ejc` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `historico_equipes`
--

LOCK TABLES `historico_equipes` WRITE;
/*!40000 ALTER TABLE `historico_equipes` DISABLE KEYS */;
/*!40000 ALTER TABLE `historico_equipes` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-03-23 15:42:32
