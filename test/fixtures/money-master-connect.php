<?php
// Database adapter for exercising the real PHP bridge without a live database.
// SQL storage/locking itself must additionally be verified against MariaDB.
date_default_timezone_set('Asia/Dubai');
class SyncTestResult {
    public $rows; public $offset = 0;
    public function __construct($rows) { $this->rows = array_values($rows); }
}
class SyncTestDatabase {
    public $state; private $snapshot; private $lastId = 0;
    public function __construct() { $this->state = json_decode(file_get_contents(getenv('SYNC_TEST_STATE')), true); }
    public function fetch_assoc($result) { return $result->rows[$result->offset++] ?? null; }
    public function insert_id() { return $this->lastId; }
    public function query($sql, $params = []) {
        if (strpos($sql, 'information_schema.TABLES') !== false) return new SyncTestResult([['TABLE_NAME' => 'ac_transactions', 'ENGINE' => 'InnoDB'], ['TABLE_NAME' => 'ac_stripe_sync', 'ENGINE' => 'InnoDB']]);
        if (strpos($sql, 'FROM ac_ledgers l JOIN') !== false) return new SyncTestResult(json_decode(getenv('SYNC_TEST_LEDGERS'), true));
        if (strpos($sql, 'SELECT id FROM users') === 0) return new SyncTestResult([['id' => 68]]);
        if (strpos($sql, 'SELECT GET_LOCK') === 0) return new SyncTestResult([['acquired' => 1]]);
        if (strpos($sql, 'SELECT RELEASE_LOCK') === 0) return new SyncTestResult([['released' => 1]]);
        if ($sql === 'START TRANSACTION') { $this->snapshot = $this->state; return true; }
        if ($sql === 'ROLLBACK') { $this->state = $this->snapshot; return true; }
        if ($sql === 'COMMIT') { file_put_contents(getenv('SYNC_TEST_STATE'), json_encode($this->state)); return true; }
        if (strpos($sql, 'SELECT * FROM ac_stripe_sync WHERE entry_key') === 0) return new SyncTestResult(isset($this->state['receipts'][$params[0]]) ? [$this->state['receipts'][$params[0]]] : []);
        if (strpos($sql, 'SELECT entry_key, payload_hash') === 0) return new SyncTestResult(array_values($this->state['receipts']));
        if (strpos($sql, 'FROM ac_transactions WHERE id IN') !== false) return new SyncTestResult(array_filter($this->state['transactions'], function ($row) use ($params) { return in_array($row['id'], $params[0]); }));
        if (strpos($sql, 'SELECT id FROM ac_transactions') === 0) return new SyncTestResult(array_filter($this->state['transactions'], function ($row) use ($params, $sql) { return $row['reference'] === $params[0] && (strpos($sql, 'AND deleted = 0') === false || $row['deleted'] === 0); }));
        if (strpos($sql, 'UPDATE ac_transactions SET deleted = 0') === 0) {
            foreach ($this->state['transactions'] as &$row) if (in_array($row['id'], $params[0]) && $row['login_center'] === 12 && $row['deleted'] === 1) { $row['deleted'] = 0; $row['approved'] = 0; }
            unset($row);
            return true;
        }
        if (strpos($sql, 'UPDATE ac_transactions SET reason = ?') === 0) {
            foreach ($this->state['transactions'] as &$row) if (in_array($row['id'], $params[1]) && $row['login_center'] === 12) { $row['reason'] = $params[0]; $row['approved'] = 0; $row['deleted'] = 0; }
            unset($row);
            return true;
        }
        if (strpos($sql, 'UPDATE ac_stripe_sync SET payload_hash = ?') === 0) {
            if (!empty($this->state['fail_receipt_update'])) return false;
            $this->state['receipts'][$params[2]]['payload_hash'] = $params[0];
            $this->state['receipts'][$params[2]]['payload'] = $params[1];
            return true;
        }
        if (strpos($sql, 'INSERT INTO ac_transactions') === 0) {
            if (($this->state['fail_on_ledger'] ?? null) === $params[1]) return false;
            $id = count($this->state['transactions']) + 1; $this->lastId = $id;
            $row = array_combine(['account_id', 'ledger_id', 'opposite_account', 'opposite_ledger', 'debit', 'credit', 'reference', 'reason', 'created_by', 'created_date', 'transaction_date', 'approved'], $params);
            $this->state['transactions'][] = array_merge($row, ['id' => $id, 'login_center' => 12, 'deleted' => 0]);
            return true;
        }
        if (strpos($sql, 'INSERT INTO ac_stripe_sync') === 0) {
            $this->state['receipts'][$params[0]] = array_combine(['entry_key', 'payload_hash', 'payload', 'transaction_ids', 'created_by', 'created_at'], $params);
            return true;
        }
        throw new RuntimeException('Unexpected test query: ' . $sql);
    }
}
$db = new SyncTestDatabase();
