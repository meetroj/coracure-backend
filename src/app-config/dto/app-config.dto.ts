import { ApiProperty } from '@nestjs/swagger';
import { IsDefined } from 'class-validator';

export class SetConfigDto {
  /**
   * The new value, in whatever shape the setting takes — a number for a fee
   * percentage, a boolean for a switch, an array for a keyword list.
   *
   * Deliberately unvalidated HERE beyond "present". The shape is not this DTO's
   * to know: the module that reads the value registered its schema, and the
   * service checks against that. A second set of rules in this file would be a
   * second thing to keep in step with the reading code.
   */
  @ApiProperty({
    description: 'The new value. Its shape is checked against the setting’s registered schema.',
    examples: { percentage: { value: 18 }, toggle: { value: true }, list: { value: ['a', 'b'] } },
  })
  @IsDefined()
  value!: unknown;
}
