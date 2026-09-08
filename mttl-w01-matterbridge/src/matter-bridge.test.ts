import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Environment } from "@matter/main";
import { ElectricalEnergyMeasurementServer } from "@matter/main/behaviors";
import { MockStorageService } from "@matter/general";
import { DeviceRegistry } from "./device-registry.js";
import { MatterPowerStripBridge } from "./matter-bridge.js";

for (const isGroupByDevice of [false, true]) {
  test(`profile grouped=${isGroupByDevice}: topology, telemetry, commands and reset`, async () => {
    const environment = new Environment(`matter-profile-${isGroupByDevice}`, Environment.default);
    new MockStorageService(environment);
    const commands: Array<[string, number, boolean]> = [];
    const bridge = await MatterPowerStripBridge.create({
      environment, matterPort: 0, isGroupByDevice,
      onOutletCommand: (id, outlet, on) => { commands.push([id, outlet, on]); },
    });
    try {
      for (const id of ["STRIP_A", "STRIP_B"]) {
        await bridge.addPowerStrip({ id, firmwareVersion: "1.0", reachable: false });
        const device = bridge["devices"].get(id)!;
        for (let index = 0; index < 4; index++) {
          const outlet = device.outlets[index];
          const sensor = device.electricalSensors[index];
          assert.equal(outlet.owner, isGroupByDevice ? device.container : sensor);
          assert.equal(sensor.owner, device.container);
          assert.deepEqual(outlet.state.descriptor.partsList, []);
          if (isGroupByDevice) {
            assert.equal(sensor, outlet);
            assert.equal(outlet.state.temperatureMeasurement.measuredValue, null);
            assert.equal(outlet.state.fixedLabel.labelList.length, 1);
            assert.equal(outlet.state.fixedLabel.labelList[0].label, "ha_entitylabel");
            assert.equal(outlet.state.fixedLabel.labelList[0].value, `Outlet ${index + 1}`);
            assert.deepEqual(
              outlet.state.descriptor.deviceTypeList.map((entry: { deviceType: number }) => entry.deviceType).sort(),
              [0x10a, 0x302, 0x510].sort(),
            );
          } else {
            assert.deepEqual(sensor.state.descriptor.partsList, [outlet.number]);
            assert.equal(outlet.state.temperatureMeasurement, undefined);
          }
        }
        assert.deepEqual(
          [...device.container.state.descriptor.partsList].sort(),
          [...new Set([...device.outlets, ...device.electricalSensors].map(endpoint => endpoint.number))].sort(),
        );
      }
      const device = bridge["devices"].get("STRIP_A")!;
      let energyEvents = 0;
      device.electricalSensors[1].events.electricalEnergyMeasurement.cumulativeEnergyMeasured.on(() => { energyEvents++; });
      const sample = {
        index: 2, on: true, powerW: 12.345, energyWh: 678.9, temperatureC: -12.5,
        overloadProtection: true, overheatProtection: false, deviceStatus: true,
        eventCode: "0A", configurationHex: "12345678", testState: 1, fixedValue: 0,
        powerRaw: 12345, energyMeterHex: "000002A6", previousEnergyMeterHex: "00000042", energyKWh: 0.6789,
      };
      await bridge.updateTelemetry("STRIP_A", { outlets: [sample] });
      assert.deepEqual(bridge.getDevice("STRIP_A").outlets[1], sample);
      assert.deepEqual(commands, []);
      assert.equal(device.electricalSensors[1].state.electricalPowerMeasurement.activePower, 12345);
      assert.equal(device.electricalSensors[1].state.electricalEnergyMeasurement.cumulativeEnergyImported.energy, 678900);
      assert.equal(energyEvents, 1);
      if (isGroupByDevice) {
        assert.equal(device.outlets[1].state.temperatureMeasurement.measuredValue, -1250);
        await bridge.updateTelemetry("STRIP_A", { outlets: [{ index: 2, powerW: 1, energyWh: 2 }] });
        assert.equal(device.outlets[1].state.temperatureMeasurement.measuredValue, -1250);
        await bridge.updateTelemetry("STRIP_A", { outlets: [{ index: 2, powerW: 2, energyWh: 3, temperatureC: 999 }] });
        assert.equal(device.outlets[1].state.temperatureMeasurement.measuredValue, null);
        await bridge.updateTelemetry("STRIP_A", { outlets: [sample] });
        await bridge.setFirmwareVersion("STRIP_A", "2.0");
        assert.equal(device.container.state.bridgedDeviceBasicInformation.softwareVersionString, "2.0");
      }
      await bridge.setReachable("STRIP_A", true);
      await bridge.setOutlet("STRIP_A", 2, false);
      assert.deepEqual(commands, [["STRIP_A", 2, false]]);
      assert.equal(bridge.getDevice("STRIP_B").outlets[1].on, false);
      assert.equal(bridge.getDevice("STRIP_B").outlets[1].powerW, 0);

      // Simulate attributes erased during commissioning reset, leaving the
      // cached physical telemetry intact, without starting a network listener.
      bridge.server.erase = async () => {
        await device.outlets[1].set({ onOff: { onOff: true } });
        await device.electricalSensors[1].set({ electricalPowerMeasurement: { activePower: 0 } });
        await device.electricalSensors[1].act(agent =>
          agent.get(ElectricalEnergyMeasurementServer).setMeasurement({ cumulativeEnergy: { imported: { energy: 0 } } }),
        );
        if (isGroupByDevice) await device.outlets[1].set({ temperatureMeasurement: { measuredValue: null } });
      };
      await bridge.resetMatterCommissioning();
      assert.equal(device.outlets[1].state.onOff.onOff, false);
      assert.equal(device.electricalSensors[1].state.electricalPowerMeasurement.activePower, 12345);
      assert.equal(device.electricalSensors[1].state.electricalEnergyMeasurement.cumulativeEnergyImported.energy, 678900);
      if (isGroupByDevice) assert.equal(device.outlets[1].state.temperatureMeasurement.measuredValue, -1250);
      assert.deepEqual(commands, [["STRIP_A", 2, false]]);
      await bridge.removePowerStrip("STRIP_B");
      assert.equal(bridge.listDevices().length, 1);
    } finally {
      await bridge.close();
    }
  });
}

test("only deletes offline devices and persists removal across registry reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mttl-delete-"));
  const registry = new DeviceRegistry(join(directory, "devices.json"));
  await registry.load();
  const environment = new Environment("matter-delete-test", Environment.default);
  new MockStorageService(environment);
  const bridge = await MatterPowerStripBridge.create({ environment, matterPort: 0, registry });
  try {
    await bridge.addPowerStrip({ id: "DELETE_TEST" });
    await assert.rejects(bridge.removePowerStrip("DELETE_TEST"), /온라인 기기는 삭제할 수 없습니다/);
    assert.equal(bridge.listDevices().length, 1);
    assert.equal(registry.list().length, 1);

    await bridge.setReachable("DELETE_TEST", false);
    await bridge.removePowerStrip("DELETE_TEST");
    assert.deepEqual(bridge.listDevices(), []);
    assert.deepEqual(await new DeviceRegistry(registry.filePath).load(), []);
    await assert.rejects(bridge.removePowerStrip("DELETE_TEST"), /not found/);

    await bridge.addPowerStrip({ id: "DELETE_TEST" });
    assert.equal(bridge.getDevice("DELETE_TEST").reachable, true);
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes Matter outlet commands to the physical-device handler", async () => {
  const environment = new Environment("matter-command-test", Environment.default);
  new MockStorageService(environment);
  const commands: Array<[string, number, boolean]> = [];
  const bridge = await MatterPowerStripBridge.create({
    environment,
    matterPort: 0,
    onOutletCommand: async (id, outlet, on) => {
      commands.push([id, outlet, on]);
    },
  });

  try {
    await bridge.addPowerStrip({ id: "TEST" });
    await bridge.setOutlet("TEST", 2, true);

    assert.deepEqual(commands, [["TEST", 2, true]]);
    assert.equal(bridge.getDevice("TEST").outlets[1].on, true);

    await bridge.setOutlet("TEST", 2, false);
    assert.deepEqual(commands, [
      ["TEST", 2, true],
      ["TEST", 2, false],
    ]);
    assert.equal(bridge.getDevice("TEST").outlets[1].on, false);

    await bridge.syncOutletState("TEST", 2, true);
    assert.equal(commands.length, 2);
    assert.equal(bridge.getDevice("TEST").outlets[1].on, true);
  } finally {
    await bridge.close();
  }
});

test("rolls Matter state back when the physical command fails", async () => {
  const environment = new Environment("matter-command-failure-test", Environment.default);
  new MockStorageService(environment);
  const bridge = await MatterPowerStripBridge.create({
    environment,
    matterPort: 0,
    onOutletCommand: async () => {
      throw new Error("device offline");
    },
  });

  try {
    await bridge.addPowerStrip({ id: "TESTFAIL" });
    await assert.rejects(
      bridge.setOutlet("TESTFAIL", 1, true),
      /device offline/,
    );
    assert.equal(bridge.getDevice("TESTFAIL").outlets[0].on, false);
  } finally {
    await bridge.close();
  }
});


test("restored offline devices publish Matter reachability changes on reconnect", async () => {
  const environment = new Environment("matter-reachability-test", Environment.default);
  new MockStorageService(environment);
  const bridge = await MatterPowerStripBridge.create({ environment, matterPort: 0 });
  try {
    await bridge.addPowerStrip({ id: "REACHABLE_TEST", reachable: false });
    const container = bridge["devices"].get("REACHABLE_TEST")!.container;
    const reports: boolean[] = [];
    container.events.bridgedDeviceBasicInformation.reachableChanged.on(
      (event: { reachableNewValue: boolean }) => { reports.push(event.reachableNewValue); },
    );
    assert.equal(container.state.bridgedDeviceBasicInformation.reachable, false);
    await bridge.setReachable("REACHABLE_TEST", true);
    await bridge.setReachable("REACHABLE_TEST", false);
    await bridge.setReachable("REACHABLE_TEST", true);
    assert.equal(container.state.bridgedDeviceBasicInformation.reachable, true);
    assert.equal(bridge.getDevice("REACHABLE_TEST").reachable, true);
    assert.deepEqual(reports, [true, false, true]);
  } finally {
    await bridge.close();
  }
});
