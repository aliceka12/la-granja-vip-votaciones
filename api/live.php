<?php
/**
 * Proxy API en Tiempo Real para Votaciones de La Granja VIP (TV Azteca)
 * Obtiene la configuración activa, el estado y el conteo exacto de votos en tiempo real
 * directamente desde los servidores de vota.tvazteca.com y actualiza el snapshot JSON.
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
header('Access-Control-Allow-Private-Network: true');
header('Cache-Control: no-cache, no-store, must-revalidate');

if (isset($_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$baseUrl = 'https://vota.tvazteca.com';

function fetchJson($url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER => [
            'Accept: application/json',
            'Origin: https://www.tvazteca.com',
            'Referer: https://www.tvazteca.com/'
        ]
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode >= 200 && $httpCode < 300 && $response) {
        return json_decode($response, true);
    }
    return null;
}

$config = fetchJson("$baseUrl/config/vota.json");
$status = fetchJson("$baseUrl/config/vota-status.json");

if (!$config) {
    // Si falla la red, intentar devolver el último snapshot guardado
    $snapshotFile = __DIR__ . '/../data/snapshot.json';
    if (file_exists($snapshotFile)) {
        echo file_get_contents($snapshotFile);
        exit;
    }
    http_response_code(502);
    echo json_encode(['error' => 'No se pudo conectar con el servidor de votaciones de TV Azteca.']);
    exit;
}

$polls = [];

// Procesar Votación Principal (voting)
if (!empty($config['voting']) && !empty($config['voting']['configId'])) {
    $v1 = $config['voting'];
    $cid1 = $v1['configId'];
    $res1 = fetchJson("$baseUrl/api/results?config_id=" . urlencode($cid1)) ?: [];
    $polls[] = formatPoll($v1, $res1, 'principal', $baseUrl);
}

// Procesar Segunda Votación Simultánea (voting2)
if (!empty($config['voting2']) && !empty($config['voting2']['enabled']) && !empty($config['voting2']['configId'])) {
    $v2 = $config['voting2'];
    $cid2 = $v2['configId'];
    $res2 = fetchJson("$baseUrl/api/results?config_id=" . urlencode($cid2)) ?: [];
    $polls[] = formatPoll($v2, $res2, 'secundaria', $baseUrl);
}

function formatPoll($votingConfig, $rawResults, $key, $baseUrl) {
    $contestants = $votingConfig['contestants'] ?? [];
    $activeContestants = [];
    $totalActiveVotes = 0;
    $totalAllVotes = array_sum(array_map('intval', $rawResults));

    foreach ($contestants as $c) {
        if (!empty($c['deleted'])) {
            continue;
        }
        $id = $c['id'];
        $votes = isset($rawResults[$id]) ? (int)$rawResults[$id] : 0;
        $totalActiveVotes += $votes;

        $img = $c['image'] ?? '';
        if ($img && strpos($img, 'http') !== 0) {
            $img = $baseUrl . (strpos($img, '/') === 0 ? '' : '/') . $img;
        }

        $activeContestants[] = [
            'id' => $id,
            'name' => $c['name'] ?? 'Participante',
            'image' => $img,
            'votes' => $votes
        ];
    }

    // Calcular porcentajes y ordenar de mayor a menor voto
    usort($activeContestants, function($a, $b) {
        return $b['votes'] <=> $a['votes'];
    });

    foreach ($activeContestants as $idx => &$item) {
        $item['rank'] = $idx + 1;
        $item['percentage'] = $totalActiveVotes > 0 
            ? round(($item['votes'] / $totalActiveVotes) * 100, 2) 
            : 0;
    }

    return [
        'key' => $key,
        'configId' => $votingConfig['configId'],
        'internalName' => $votingConfig['name'] ?? '',
        'title' => $votingConfig['title'] ?? 'Votación Activa',
        'subtitle' => str_replace('{n}', (string)($votingConfig['maxVotes'] ?? 10), $votingConfig['subtitle'] ?? ''),
        'maxVotes' => $votingConfig['maxVotes'] ?? 10,
        'accentColor' => $votingConfig['accentColor'] ?? '#da07c8',
        'extraColor' => $votingConfig['extraColor'] ?? '#d5d546',
        'totalActiveVotes' => $totalActiveVotes,
        'totalRawVotes' => $totalAllVotes,
        'contestants' => $activeContestants,
        'rawResults' => $rawResults
    ];
}

$payload = [
    'ok' => true,
    'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
    'localTime' => date('Y-m-d H:i:s'),
    'sourceUrl' => 'https://www.tvazteca.com/aztecauno/la-granja-votaciones/vota/',
    'apiEndpoint' => $baseUrl,
    'programTitle' => $config['nombre'] ?? 'La Granja VIP Segunda Temporada',
    'logo' => !empty($config['logo']['image']) ? ($baseUrl . $config['logo']['image']) : '',
    'status' => [
        'active' => $status['active'] ?? true,
        'votingOpen' => $status['voting_open'] ?? true,
        'votingClosedText' => $status['voting_closed_text'] ?? '',
        'configVersion' => $status['config_version'] ?? ''
    ],
    'polls' => $polls
];

$jsonOutput = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

// Guardar snapshot actualizado para modo estático / GitHub Pages
$snapshotDir = __DIR__ . '/../data';
if (is_dir($snapshotDir) && is_writable($snapshotDir)) {
    @file_put_contents($snapshotDir . '/snapshot.json', $jsonOutput);
}

echo $jsonOutput;
