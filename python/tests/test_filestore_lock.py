"""FileStore.update(): two FileStore instances on one profile (threads, and separate processes) lose no updates; a lock
left by a dead process is replaced, a live one makes others wait (then profile_busy); an unreadable profile is never
overwritten; a failed update saves nothing. Offline, in a temporary folder."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
sys.path.insert(0, SRC)
from valun import client as vc  # noqa: E402
from valun import records  # noqa: E402

N = 30
WORKER = '''
import sys
sys.path.insert(0, {src!r})
from valun import client as vc, records
s = vc.FileStore({path!r})
for i in range({n}):
    def fn(st, i=i):
        st.setdefault('n', {{}})[{name!r}] = st.get('n', {{}}).get({name!r}, 0) + 1
        records.add_pending(st.setdefault('records', {{}}), {name!r} + '>x', i + 1, 1000 + i, 'note', 'vd_%d' % i)
    s.update(fn)
'''


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'profile.json')
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'server': 'http://valun.invalid', 'secret': 'ab' * 32, 'agent_token': 'vpa_test-only', 'issued': {}}, f)

    def tearDown(self):
        self.tmp.cleanup()

    def disk(self):
        with open(self.path, encoding='utf-8') as f:
            return json.load(f)

    def assert_clean(self):
        left = [f for f in os.listdir(self.tmp.name) if f.endswith(('.lock', '.tmp'))]
        self.assertEqual(left, [])


class NoLostUpdates(Base):
    def counted(self, name):
        def fn(st, i):
            st.setdefault('n', {})[name] = st.get('n', {}).get(name, 0) + 1
            records.add_pending(st.setdefault('records', {}), name + '>x', i + 1, 1000 + i, 'note', f'vd_{i}')
        return fn

    def check(self, names):
        disk = self.disk()
        self.assertEqual(disk['n'], {name: N for name in names})
        for name in names:
            self.assertEqual([p['total'] for p in disk['records'][name + '>x']['pending']], list(range(1, N + 1)))
        self.assertEqual((disk['secret'], disk['agent_token'], disk['server']), ('ab' * 32, 'vpa_test-only', 'http://valun.invalid'))
        self.assert_clean()

    def test_two_instances_in_threads(self):
        stores = {'a': vc.FileStore(self.path), 'b': vc.FileStore(self.path)}    # both loaded before either writes
        errors = []

        def work(name):
            try:
                fn = self.counted(name)
                for i in range(N):
                    stores[name].update(lambda st, i=i: fn(st, i))
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        threads = [threading.Thread(target=work, args=(n,)) for n in stores]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        self.assertEqual(errors, [])
        self.check(['a', 'b'])

    def test_two_processes(self):
        procs = [subprocess.Popen([sys.executable, '-I', '-c', WORKER.format(src=SRC, path=self.path, n=N, name=name)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE) for name in ('a', 'b')]
        for p in procs:
            out, err = p.communicate(timeout=120)
            self.assertEqual(p.returncode, 0, err.decode('utf-8', 'replace'))
        self.check(['a', 'b'])

    def test_clients_on_one_profile_keep_each_others_records(self):
        a, b = vc.Client(self.path), vc.Client(self.path)
        a._update(lambda st: records.add_pending(vc._records_in(st), 'k1>r', 5, 100, 'note', 'vd_a'))
        b._update(lambda st: records.add_pending(vc._records_in(st), 'k2>r', 7, 200, 'note', 'vd_b'))
        recs = self.disk()['records']
        self.assertEqual(sorted(recs), ['k1>r', 'k2>r'])
        self.assertEqual(sorted(b.state['records']), ['k1>r', 'k2>r'])       # b saw a's entry when it updated


class Locking(Base):
    def test_a_stale_lock_is_replaced(self):
        lock = self.path + '.lock'
        with open(lock, 'w') as f:
            f.write('99999 0\n')
        old = time.time() - 120
        os.utime(lock, (old, old))
        vc.FileStore(self.path).update(lambda st: st.__setitem__('k', 1))
        self.assertEqual(self.disk()['k'], 1)
        self.assert_clean()

    def test_a_live_lock_makes_others_wait_then_gives_up(self):
        class Quick(vc.FileStore):
            LOCK_WAIT_S = 0.3
        lock = self.path + '.lock'
        open(lock, 'w').close()                     # another process holds the profile
        try:
            t0 = time.monotonic()
            with self.assertRaises(vc.ValunError) as e:
                Quick(self.path).update(lambda st: st.__setitem__('k', 2))
            self.assertEqual(e.exception.code, 'profile_busy')
            self.assertGreaterEqual(time.monotonic() - t0, 0.25)
            self.assertNotIn('k', self.disk())
        finally:
            os.unlink(lock)

    def test_a_waiting_writer_proceeds_when_the_lock_is_released(self):
        lock = self.path + '.lock'
        open(lock, 'w').close()
        threading.Timer(0.3, os.unlink, args=(lock,)).start()
        vc.FileStore(self.path).update(lambda st: st.__setitem__('k', 3))
        self.assertEqual(self.disk()['k'], 3)
        self.assert_clean()


class Safety(Base):
    def test_an_unreadable_profile_is_never_overwritten(self):
        s = vc.FileStore(self.path)
        before = dict(s.state)
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('{"cut off')
        with self.assertRaises(vc.ValunError) as e:
            s.update(lambda st: st.__setitem__('k', 1))
        self.assertEqual(e.exception.code, 'records_unreadable')
        with open(self.path, encoding='utf-8') as f:
            self.assertEqual(f.read(), '{"cut off')
        self.assertEqual(s.state, before)
        with self.assertRaises(vc.ValunError):
            s.reload()
        self.assert_clean()

    def test_a_failed_update_saves_nothing(self):
        s = vc.FileStore(self.path)
        before, disk = dict(s.state), self.disk()

        def fn(st):
            st['k'] = 1
            raise RuntimeError('boom')
        with self.assertRaises(RuntimeError):
            s.update(fn)
        self.assertEqual((s.state, self.disk()), (before, disk))
        self.assert_clean()

    def test_update_reloads_in_place(self):
        a, b = vc.FileStore(self.path), vc.FileStore(self.path)
        st = a.state
        b.update(lambda s: s.__setitem__('x', 1))
        a.update(lambda s: s.__setitem__('y', 2))
        self.assertIs(a.state, st)                  # a client holding a.state sees the reloaded state
        self.assertEqual((a.state['x'], a.state['y']), (1, 2))
        self.assertEqual((self.disk()['x'], self.disk()['y']), (1, 2))

    def test_update_creates_a_new_profile(self):
        path = os.path.join(self.tmp.name, 'sub', 'new.json')
        s = vc.FileStore(path)
        s.state['server'] = 'http://valun.invalid'
        s.update(lambda st: st.__setitem__('pins', {'tracker_nft_id': '11' * 32, 'denomination': 'erg'}))
        with open(path, encoding='utf-8') as f:
            self.assertEqual(json.load(f), {'server': 'http://valun.invalid', 'pins': {'tracker_nft_id': '11' * 32, 'denomination': 'erg'}})


if __name__ == '__main__':
    unittest.main()
